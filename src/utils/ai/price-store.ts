/**
 * AI model price persistence service (Issue #200, US3 / T114). D1-facing, shared
 * by the JSON API (`src/routes/ai.ts`, API-key auth) and the owner dashboard
 * price controls (`src/routes/app.tsx`, session-cookie auth) so both surfaces
 * enforce one set of invariants — no duplicated INSERT/UPDATE/overlap logic.
 *
 * Field-level validation stays in `pricing.ts` (pure); this module owns the
 * queries and the stored-row invariants (window overlap, default-row protection,
 * ownership scoping) that need the database to evaluate.
 */
import {
  PRICE_SELECT_COLUMNS,
  toMs,
  windowsOverlap,
  type AiModelPriceRow,
  type CreatePriceValue,
  type UpdatePriceValue,
} from "./pricing";
import { defaultPriceRows } from "./default-prices";

/** Only the two window columns, read for the overlap invariant. */
interface WindowRow {
  effective_from: string;
  effective_to: string | null;
}

/** Filters accepted by {@link listPrices}, mirroring the `GET /ai/prices` query. */
export interface ListPricesOptions {
  provider?: string;
  model?: string;
  /** Epoch ms; keep only rows whose `[from, to)` window contains this instant. */
  activeOnMs?: number;
  /** Include disabled rows (`is_enabled = 0`); defaults to enabled-only. */
  includeDisabled?: boolean;
}

/** Result of a create/update mutation: the persisted row or a 400-worthy reason. */
export type PriceMutationResult =
  | { ok: true; row: AiModelPriceRow }
  | { ok: false; error: string };

const OVERLAP_ERROR =
  "effective window overlaps an existing enabled price row for this provider/model";

/**
 * Fetch enabled owner rows (`is_default = 0`) for one `(provider, model)` whose
 * window could collide with a new/updated enabled row, optionally excluding the
 * row being updated. Only the two window columns are read.
 */
async function enabledOwnerWindows(
  db: D1Database,
  userId: string,
  provider: string,
  model: string,
  excludeId?: string,
): Promise<WindowRow[]> {
  const sql =
    "SELECT effective_from, effective_to FROM ai_model_prices " +
    "WHERE user_id = ? AND provider = ? AND model = ? AND is_default = 0 AND is_enabled = 1" +
    (excludeId ? " AND id != ?" : "");
  const binds = excludeId ? [userId, provider, model, excludeId] : [userId, provider, model];
  const { results } = await db.prepare(sql).bind(...binds).all<WindowRow>();
  return results;
}

/** Read one owner-visible price row (owner-created or default) by id, or null. */
export async function fetchPriceRow(
  db: D1Database,
  userId: string,
  priceId: string,
): Promise<AiModelPriceRow | null> {
  return db
    .prepare(`SELECT ${PRICE_SELECT_COLUMNS} FROM ai_model_prices WHERE id = ? AND user_id = ?`)
    .bind(priceId, userId)
    .first<AiModelPriceRow>();
}

/**
 * All enabled owner price rows for the user (used by cost estimation). Shipped
 * defaults are NOT merged here: they are resolved per used (provider, model) at
 * the call site (see `resolveDefaultPrice`) so family-based defaults cover any
 * concrete version, which a fixed list cannot.
 */
export async function listEnabledPrices(
  db: D1Database,
  userId: string,
): Promise<AiModelPriceRow[]> {
  const { results } = await db
    .prepare(`SELECT ${PRICE_SELECT_COLUMNS} FROM ai_model_prices WHERE user_id = ? AND is_enabled = 1`)
    .bind(userId)
    .all<AiModelPriceRow>();
  return results;
}

/**
 * List owner-visible price rows (owner + default) filtered and ordered exactly as
 * the contract requires: optional `provider`/`model`/`active_on`/`include_disabled`
 * filters, then provider, model, `effective_from` ascending (by parsed instant so
 * mixed offsets order chronologically, not lexically).
 */
export async function listPrices(
  db: D1Database,
  userId: string,
  opts: ListPricesOptions = {},
): Promise<AiModelPriceRow[]> {
  let sql = `SELECT ${PRICE_SELECT_COLUMNS} FROM ai_model_prices WHERE user_id = ?`;
  const binds: (string | number)[] = [userId];
  if (opts.provider !== undefined) {
    sql += " AND provider = ?";
    binds.push(opts.provider);
  }
  if (opts.model !== undefined) {
    sql += " AND model = ?";
    binds.push(opts.model);
  }
  if (!opts.includeDisabled) sql += " AND is_enabled = 1";

  const { results } = await db.prepare(sql).bind(...binds).all<AiModelPriceRow>();

  // Merge the shipped default catalog (is_default = 1). Defaults are enabled and
  // open-ended, so `include_disabled` never excludes them; apply the same
  // provider/model filters, then the shared `active_on` filter and ordering below
  // treat owner and default rows uniformly.
  let defaults = defaultPriceRows(userId);
  if (opts.provider !== undefined) defaults = defaults.filter((r) => r.provider === opts.provider);
  if (opts.model !== undefined) defaults = defaults.filter((r) => r.model === opts.model);

  let rows = [...results, ...defaults];
  if (opts.activeOnMs !== undefined) {
    const at = opts.activeOnMs;
    rows = rows.filter((r) => {
      const from = toMs(r.effective_from);
      const to = r.effective_to == null ? Infinity : toMs(r.effective_to);
      return from <= at && at < to;
    });
  }
  return [...rows].sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      a.model.localeCompare(b.model) ||
      toMs(a.effective_from) - toMs(b.effective_from),
  );
}

/**
 * Insert a validated owner-scoped price row. Rejects (400-worthy) a new *enabled*
 * row whose window overlaps an existing enabled owner window for the same
 * `(provider, model)` so at most one enabled row matches any instant (FR-021);
 * disabled rows may overlap freely. Returns the persisted row.
 */
export async function insertPrice(
  db: D1Database,
  userId: string,
  v: CreatePriceValue,
): Promise<PriceMutationResult> {
  if (v.is_enabled) {
    const windows = await enabledOwnerWindows(db, userId, v.provider, v.model);
    const clash = windows.some((w) =>
      windowsOverlap(v.effective_from, v.effective_to, w.effective_from, w.effective_to),
    );
    if (clash) return { ok: false, error: OVERLAP_ERROR };
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO ai_model_prices
         (id, user_id, provider, model, currency,
          input_cost_per_mtok, cached_input_cost_per_mtok, output_cost_per_mtok,
          reasoning_output_cost_per_mtok, cache_write_cost_per_mtok, cache_read_cost_per_mtok,
          effective_from, effective_to, source_url, is_default, is_enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'), datetime('now'))`,
    )
    .bind(
      id,
      userId,
      v.provider,
      v.model,
      v.currency,
      v.rates.input_cost_per_mtok,
      v.rates.cached_input_cost_per_mtok,
      v.rates.output_cost_per_mtok,
      v.rates.reasoning_output_cost_per_mtok,
      v.rates.cache_write_cost_per_mtok,
      v.rates.cache_read_cost_per_mtok,
      v.effective_from,
      v.effective_to,
      v.source_url,
      v.is_enabled ? 1 : 0,
    )
    .run();

  const row = await fetchPriceRow(db, userId, id);
  if (!row) throw new Error("price row vanished after insert");
  return { ok: true, row };
}

/**
 * Apply a validated partial update to an existing owner row. The caller has
 * already resolved existence/ownership and rejected default rows (404). Rechecks
 * that the post-update `effective_to` stays strictly after the immutable
 * `effective_from`, and that an enabled result does not overlap another enabled
 * owner window for the same `(provider, model)`.
 */
export async function applyPriceUpdate(
  db: D1Database,
  userId: string,
  row: AiModelPriceRow,
  v: UpdatePriceValue,
): Promise<PriceMutationResult> {
  const nextTo = v.effectiveToProvided ? v.effectiveTo : row.effective_to;
  if (nextTo !== null && toMs(nextTo) <= toMs(row.effective_from)) {
    return { ok: false, error: "effective_to must be strictly after effective_from" };
  }

  const nextEnabled = v.isEnabledProvided ? v.isEnabled : row.is_enabled === 1;
  if (nextEnabled) {
    const windows = await enabledOwnerWindows(db, userId, row.provider, row.model, row.id);
    const clash = windows.some((w) =>
      windowsOverlap(row.effective_from, nextTo, w.effective_from, w.effective_to),
    );
    if (clash) return { ok: false, error: OVERLAP_ERROR };
  }

  const setClause = [...v.columns.map((col) => `${col} = ?`), "updated_at = datetime('now')"].join(", ");
  await db
    .prepare(`UPDATE ai_model_prices SET ${setClause} WHERE id = ? AND user_id = ?`)
    .bind(...v.values, row.id, userId)
    .run();

  const updated = await fetchPriceRow(db, userId, row.id);
  if (!updated) throw new Error("price row vanished after update");
  return { ok: true, row: updated };
}

/**
 * Delete an owner-created row. Default rows (`is_default = 1`), unknown ids, and
 * cross-user ids all match zero rows and return false, so id existence is never
 * leaked. Returns true only when a row was removed.
 */
export async function deletePrice(
  db: D1Database,
  userId: string,
  priceId: string,
): Promise<boolean> {
  const res = await db
    .prepare("DELETE FROM ai_model_prices WHERE id = ? AND user_id = ? AND is_default = 0")
    .bind(priceId, userId)
    .run();
  return res.meta.changes > 0;
}
