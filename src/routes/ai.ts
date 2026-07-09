/**
 * AI model price management endpoints (Issue #200, US3).
 *
 * Owner-scoped, effective-dated price rows used to turn stored AI token facts
 * into API-equivalent estimated costs. All routes are owner-only (authMiddleware)
 * and scoped by `user_id`; unknown / cross-user / default rows return 404 on the
 * single-row endpoints so id existence is never leaked. The `GET /ai/usage`
 * summary endpoint (US2) is added in a later task.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../types";
import { authMiddleware } from "../middleware/auth";
import { isValidDateTime } from "../utils/datetime";
import {
  PRICE_SELECT_COLUMNS,
  rowToAiModelPrice,
  toMs,
  validateCreatePrice,
  validateUpdatePrice,
  windowsOverlap,
  type AiModelPriceRow,
} from "../utils/ai/pricing";

const ai = new Hono<AuthEnv>();

ai.use("/ai/prices", authMiddleware);
ai.use("/ai/prices/*", authMiddleware);

interface WindowRow {
  effective_from: string;
  effective_to: string | null;
}

/**
 * Fetch enabled owner rows (`is_default = 0`) for one `(provider, model)` whose
 * window would collide with a new/updated enabled row, optionally excluding the
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

async function fetchPriceRow(
  db: D1Database,
  userId: string,
  priceId: string,
): Promise<AiModelPriceRow | null> {
  return db
    .prepare(`SELECT ${PRICE_SELECT_COLUMNS} FROM ai_model_prices WHERE id = ? AND user_id = ?`)
    .bind(priceId, userId)
    .first<AiModelPriceRow>();
}

// GET /ai/prices — list owner-visible price rows (defaults + owner rows).
ai.get("/ai/prices", async (c) => {
  const userId = c.get("userId");
  const provider = c.req.query("provider");
  const model = c.req.query("model");
  const activeOn = c.req.query("active_on");
  const includeDisabledRaw = c.req.query("include_disabled");

  if (activeOn !== undefined && !isValidDateTime(activeOn)) {
    return c.json({ error: "active_on must be a valid date-time" }, 400);
  }
  let includeDisabled = false;
  if (includeDisabledRaw !== undefined) {
    if (includeDisabledRaw !== "true" && includeDisabledRaw !== "false") {
      return c.json({ error: "include_disabled must be 'true' or 'false'" }, 400);
    }
    includeDisabled = includeDisabledRaw === "true";
  }

  try {
    let sql = `SELECT ${PRICE_SELECT_COLUMNS} FROM ai_model_prices WHERE user_id = ?`;
    const binds: (string | number)[] = [userId];
    if (provider !== undefined) {
      sql += " AND provider = ?";
      binds.push(provider);
    }
    if (model !== undefined) {
      sql += " AND model = ?";
      binds.push(model);
    }
    if (!includeDisabled) sql += " AND is_enabled = 1";

    const { results } = await c.env.DB.prepare(sql).bind(...binds).all<AiModelPriceRow>();

    let rows = results;
    if (activeOn !== undefined) {
      const at = toMs(activeOn);
      rows = rows.filter((r) => {
        const from = toMs(r.effective_from);
        const to = r.effective_to == null ? Infinity : toMs(r.effective_to);
        return from <= at && at < to;
      });
    }
    // Contract order: provider, model, then effective_from ascending. Sort by
    // parsed instant so mixed offsets order chronologically, not lexically.
    rows = [...rows].sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) ||
        a.model.localeCompare(b.model) ||
        toMs(a.effective_from) - toMs(b.effective_from),
    );

    return c.json({ data: rows.map(rowToAiModelPrice) });
  } catch (err) {
    console.error("GET /ai/prices error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// POST /ai/prices — create an owner-scoped price row.
ai.post("/ai/prices", async (c) => {
  const userId = c.get("userId");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  const parsed = validateCreatePrice(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const v = parsed.value;

  try {
    // Reject a new enabled row that overlaps an existing enabled owner window
    // for the same (provider, model) so at most one enabled row matches any
    // instant (FR-021). Disabled rows may overlap freely.
    if (v.is_enabled) {
      const windows = await enabledOwnerWindows(c.env.DB, userId, v.provider, v.model);
      const clash = windows.some((w) =>
        windowsOverlap(v.effective_from, v.effective_to, w.effective_from, w.effective_to),
      );
      if (clash) {
        return c.json(
          { error: "effective window overlaps an existing enabled price row for this provider/model" },
          400,
        );
      }
    }

    const id = crypto.randomUUID();
    await c.env.DB.prepare(
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

    const row = await fetchPriceRow(c.env.DB, userId, id);
    if (!row) return c.json({ error: "Internal server error" }, 500);
    return c.json({ data: rowToAiModelPrice(row) }, 201);
  } catch (err) {
    console.error("POST /ai/prices error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// GET /ai/prices/:price_id — a single owner-visible row (owner or default).
ai.get("/ai/prices/:price_id", async (c) => {
  const userId = c.get("userId");
  const priceId = c.req.param("price_id");
  try {
    const row = await fetchPriceRow(c.env.DB, userId, priceId);
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json({ data: rowToAiModelPrice(row) });
  } catch (err) {
    console.error("GET /ai/prices/:price_id error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// PATCH /ai/prices/:price_id — partial update of an owner-created row.
ai.patch("/ai/prices/:price_id", async (c) => {
  const userId = c.get("userId");
  const priceId = c.req.param("price_id");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  try {
    // Existence + ownership + default-row check runs BEFORE body validation so a
    // 400 never confirms an id the caller cannot edit exists (FR-015).
    const row = await fetchPriceRow(c.env.DB, userId, priceId);
    if (!row || row.is_default === 1) return c.json({ error: "Not found" }, 404);

    const parsed = validateUpdatePrice(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const v = parsed.value;

    // effective_to (if changed) must stay strictly after the immutable
    // effective_from.
    const nextTo = v.effectiveToProvided ? v.effectiveTo : row.effective_to;
    if (nextTo !== null && toMs(nextTo) <= toMs(row.effective_from)) {
      return c.json({ error: "effective_to must be strictly after effective_from" }, 400);
    }

    // Re-check the overlap invariant if the post-update row is enabled.
    const nextEnabled = v.isEnabledProvided ? v.isEnabled : row.is_enabled === 1;
    if (nextEnabled) {
      const windows = await enabledOwnerWindows(
        c.env.DB,
        userId,
        row.provider,
        row.model,
        priceId,
      );
      const clash = windows.some((w) =>
        windowsOverlap(row.effective_from, nextTo, w.effective_from, w.effective_to),
      );
      if (clash) {
        return c.json(
          { error: "effective window overlaps an existing enabled price row for this provider/model" },
          400,
        );
      }
    }

    const setClause = [...v.columns.map((col) => `${col} = ?`), "updated_at = datetime('now')"].join(", ");
    await c.env.DB.prepare(
      `UPDATE ai_model_prices SET ${setClause} WHERE id = ? AND user_id = ?`,
    )
      .bind(...v.values, priceId, userId)
      .run();

    const updated = await fetchPriceRow(c.env.DB, userId, priceId);
    if (!updated) return c.json({ error: "Internal server error" }, 500);
    return c.json({ data: rowToAiModelPrice(updated) });
  } catch (err) {
    console.error("PATCH /ai/prices/:price_id error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// DELETE /ai/prices/:price_id — remove an owner-created row (defaults 404).
ai.delete("/ai/prices/:price_id", async (c) => {
  const userId = c.get("userId");
  const priceId = c.req.param("price_id");
  try {
    // Default rows (is_default=1) are excluded from the DELETE, so they, unknown
    // ids, and cross-user ids all yield 0 changes -> 404 (no existence leak).
    const res = await c.env.DB.prepare(
      "DELETE FROM ai_model_prices WHERE id = ? AND user_id = ? AND is_default = 0",
    )
      .bind(priceId, userId)
      .run();
    if (res.meta.changes === 0) return c.json({ error: "Not found" }, 404);
    return c.body(null, 204);
  } catch (err) {
    console.error("DELETE /ai/prices/:price_id error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default ai;
