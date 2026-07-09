/**
 * AI model price validation, row mapping, and effective-price selection
 * (Issue #200, US3). Pure: no D1, no I/O. `src/routes/ai.ts` owns persistence
 * and the overlap query; this module owns the field rules and the deterministic
 * owner-over-default selection that cost estimation (US2) resolves against.
 *
 * Rates are per 1,000,000 tokens in the row `currency`. Windows are half-open
 * `[effective_from, effective_to)`; a null `effective_to` is open-ended.
 */
import type { components } from "../../types/generated";
import { normalizeDateTime, toSqliteDateTime } from "../user";
import { isValidDateTime, normalizeOptionalDate } from "../datetime";

type AIModelPrice = components["schemas"]["AIModelPrice"];

/** Maximum accepted rate per 1,000,000 tokens (OpenAPI `maximum`). */
export const RATE_MAX = 1_000_000;
const CURRENCY_RE = /^[A-Z]{3}$/;
const HTTP_URL_RE = /^https?:\/\//;
const MAX_URL_LEN = 2048;
const MAX_NAME_LEN = 255;

/** The six priced token-class rate columns, in stored/response order. */
export const RATE_FIELDS = [
  "input_cost_per_mtok",
  "cached_input_cost_per_mtok",
  "output_cost_per_mtok",
  "reasoning_output_cost_per_mtok",
  "cache_write_cost_per_mtok",
  "cache_read_cost_per_mtok",
] as const;

export type RateField = (typeof RATE_FIELDS)[number];

/** Raw `ai_model_prices` row shape as read from D1. */
export interface AiModelPriceRow {
  id: string;
  user_id: string;
  provider: string;
  model: string;
  currency: string;
  input_cost_per_mtok: number | null;
  cached_input_cost_per_mtok: number | null;
  output_cost_per_mtok: number | null;
  reasoning_output_cost_per_mtok: number | null;
  cache_write_cost_per_mtok: number | null;
  cache_read_cost_per_mtok: number | null;
  effective_from: string;
  effective_to: string | null;
  source_url: string | null;
  is_default: number;
  is_enabled: number;
  created_at: string;
  updated_at: string;
}

export const PRICE_SELECT_COLUMNS =
  "id, user_id, provider, model, currency, input_cost_per_mtok, " +
  "cached_input_cost_per_mtok, output_cost_per_mtok, reasoning_output_cost_per_mtok, " +
  "cache_write_cost_per_mtok, cache_read_cost_per_mtok, effective_from, effective_to, " +
  "source_url, is_default, is_enabled, created_at, updated_at";

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** Parse a stored (SQLite) or RFC 3339 date-time to epoch ms (UTC). */
export function toMs(v: string): number {
  return Date.parse(normalizeDateTime(v));
}

/**
 * True when the half-open windows `[aFrom, aTo)` and `[bFrom, bTo)` overlap. A
 * null `to` is treated as open-ended (+infinity), so adjacent windows that only
 * touch at a boundary (`aTo === bFrom`) do not overlap.
 */
export function windowsOverlap(
  aFrom: string,
  aTo: string | null,
  bFrom: string,
  bTo: string | null,
): boolean {
  const af = toMs(aFrom);
  const at = aTo == null ? Infinity : toMs(aTo);
  const bf = toMs(bFrom);
  const bt = bTo == null ? Infinity : toMs(bTo);
  return af < bt && bf < at;
}

/**
 * Deterministically pick the price row effective at `at` (RFC 3339 string or
 * epoch ms) from a set of ENABLED rows for one `(provider, model)`. Applies
 * FR-021 precedence: owner row over default row, then the latest
 * `effective_from`. Callers filter `is_enabled` and `(provider, model)` first.
 * Returns null when no window contains `at`.
 */
export function selectEffectivePrice<
  T extends {
    is_default: number | boolean;
    effective_from: string;
    effective_to: string | null;
  },
>(rows: readonly T[], at: string | number): T | null {
  const atMs = typeof at === "number" ? at : toMs(at);
  const matching = rows.filter((r) => {
    const from = toMs(r.effective_from);
    const to = r.effective_to == null ? Infinity : toMs(r.effective_to);
    return from <= atMs && atMs < to;
  });
  if (matching.length === 0) return null;
  matching.sort((a, b) => {
    const ad = a.is_default ? 1 : 0;
    const bd = b.is_default ? 1 : 0;
    if (ad !== bd) return ad - bd; // owner (0) precedes default (1)
    return toMs(b.effective_from) - toMs(a.effective_from); // latest first
  });
  return matching[0];
}

/** Map a D1 row to the public `AIModelPrice` response shape. */
export function rowToAiModelPrice(row: AiModelPriceRow): AIModelPrice {
  const price: AIModelPrice = {
    id: row.id,
    provider: row.provider,
    model: row.model,
    currency: row.currency,
    effective_from: normalizeDateTime(row.effective_from),
    effective_to: row.effective_to == null ? null : normalizeDateTime(row.effective_to),
    source_url: row.source_url,
    is_default: row.is_default === 1,
    is_enabled: row.is_enabled === 1,
    created_at: normalizeDateTime(row.created_at),
    updated_at: normalizeDateTime(row.updated_at),
  };
  // Preserve a 0 rate (nullish-coalescing keeps 0, drops only null/undefined).
  for (const f of RATE_FIELDS) {
    const v = row[f];
    if (v != null) price[f] = v;
  }
  return price;
}

function validateRate(field: string, v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return `${field} must be a number`;
  }
  if (v < 0) return `${field} must be >= 0`;
  if (v > RATE_MAX) return `${field} must be <= ${RATE_MAX}`;
  return null;
}

function validateCurrency(v: unknown): string | null {
  if (typeof v !== "string" || !CURRENCY_RE.test(v)) {
    return "currency must be an upper-case ISO 4217 code (^[A-Z]{3}$)";
  }
  return null;
}

function validateSourceUrl(v: unknown): ValidationResult<string> {
  if (typeof v !== "string") return fail("source_url must be a string");
  if (v.length > MAX_URL_LEN) {
    return fail(`source_url must be at most ${MAX_URL_LEN} characters`);
  }
  if (!HTTP_URL_RE.test(v)) return fail("source_url must be an http(s) URL");
  return { ok: true, value: v };
}

function emptyRates(): Record<RateField, number | null> {
  return {
    input_cost_per_mtok: null,
    cached_input_cost_per_mtok: null,
    output_cost_per_mtok: null,
    reasoning_output_cost_per_mtok: null,
    cache_write_cost_per_mtok: null,
    cache_read_cost_per_mtok: null,
  };
}

/** Normalised, ready-to-insert value produced by {@link validateCreatePrice}. */
export interface CreatePriceValue {
  provider: string;
  model: string;
  currency: string;
  rates: Record<RateField, number | null>;
  effective_from: string; // SQLite datetime (UTC, no millis)
  effective_to: string | null; // SQLite datetime or null (open-ended)
  source_url: string | null;
  is_enabled: boolean;
}

/**
 * Validate a `POST /ai/prices` body. Enforces required `provider`/`model`/
 * `effective_from`, at least one rate, `0..1e6` rates, `^[A-Z]{3}$` currency
 * (default `USD`), `http(s)` `source_url`, and `effective_to` strictly after
 * `effective_from`. Server-managed fields (`id`, `is_default`, timestamps) are
 * ignored. The `(provider, model)` overlap rule is enforced by the route
 * against stored rows.
 */
export function validateCreatePrice(body: unknown): ValidationResult<CreatePriceValue> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("Request body must be a JSON object");
  }
  const r = body as Record<string, unknown>;

  if (typeof r.provider !== "string" || r.provider.length === 0) {
    return fail("provider is required and must be a non-empty string");
  }
  if (r.provider.length > MAX_NAME_LEN) {
    return fail(`provider must be at most ${MAX_NAME_LEN} characters`);
  }
  if (typeof r.model !== "string" || r.model.length === 0) {
    return fail("model is required and must be a non-empty string");
  }
  if (r.model.length > MAX_NAME_LEN) {
    return fail(`model must be at most ${MAX_NAME_LEN} characters`);
  }
  if (typeof r.effective_from !== "string" || !isValidDateTime(r.effective_from)) {
    return fail("effective_from is required and must be a valid date-time");
  }
  const effectiveFrom = toSqliteDateTime(new Date(Date.parse(r.effective_from)));

  let currency = "USD";
  if (r.currency !== undefined) {
    const err = validateCurrency(r.currency);
    if (err) return fail(err);
    currency = r.currency as string;
  }

  const rates = emptyRates();
  let rateCount = 0;
  for (const f of RATE_FIELDS) {
    const v = r[f];
    if (v === undefined) continue;
    const err = validateRate(f, v);
    if (err) return fail(err);
    rates[f] = v as number;
    rateCount++;
  }
  if (rateCount === 0) return fail("At least one rate field is required");

  const to = normalizeOptionalDate(r.effective_to);
  if (!to.ok) return fail("effective_to must be a valid date-time");
  if (to.value !== null && toMs(to.value) <= toMs(effectiveFrom)) {
    return fail("effective_to must be strictly after effective_from");
  }

  let sourceUrl: string | null = null;
  if (r.source_url !== undefined && r.source_url !== null) {
    const res = validateSourceUrl(r.source_url);
    if (!res.ok) return fail(res.error);
    sourceUrl = res.value;
  }

  let isEnabled = true;
  if (r.is_enabled !== undefined) {
    if (typeof r.is_enabled !== "boolean") return fail("is_enabled must be a boolean");
    isEnabled = r.is_enabled;
  }

  return {
    ok: true,
    value: {
      provider: r.provider,
      model: r.model,
      currency,
      rates,
      effective_from: effectiveFrom,
      effective_to: to.value,
      source_url: sourceUrl,
      is_enabled: isEnabled,
    },
  };
}

/** Normalised column/value set produced by {@link validateUpdatePrice}. */
export interface UpdatePriceValue {
  /** Columns to `SET` and their D1-bindable values (parallel arrays). */
  columns: string[];
  values: (string | number | null)[];
  /** True when the body included `effective_to` (for the overlap re-check). */
  effectiveToProvided: boolean;
  effectiveTo: string | null;
  /** True when the body included `is_enabled` (for the overlap re-check). */
  isEnabledProvided: boolean;
  isEnabled: boolean;
}

/**
 * Validate a `PATCH /ai/prices/{id}` body. `provider`, `model`, and
 * `effective_from` are immutable (sending any returns 400). At least one
 * updatable field must be present. The route runs the ownership/default-row
 * `404`, the `effective_to`-after-`effective_from`, and overlap checks against
 * the stored row.
 */
export function validateUpdatePrice(body: unknown): ValidationResult<UpdatePriceValue> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("Request body must be a JSON object");
  }
  const r = body as Record<string, unknown>;

  for (const immutable of ["provider", "model", "effective_from"]) {
    if (immutable in r) {
      return fail("provider, model, and effective_from are immutable; create a new row instead");
    }
  }

  const columns: string[] = [];
  const values: (string | number | null)[] = [];

  if (r.currency !== undefined) {
    const err = validateCurrency(r.currency);
    if (err) return fail(err);
    columns.push("currency");
    values.push(r.currency as string);
  }

  for (const f of RATE_FIELDS) {
    if (r[f] === undefined) continue;
    const err = validateRate(f, r[f]);
    if (err) return fail(err);
    columns.push(f);
    values.push(r[f] as number);
  }

  let effectiveToProvided = false;
  let effectiveTo: string | null = null;
  if ("effective_to" in r) {
    const to = normalizeOptionalDate(r.effective_to);
    if (!to.ok) return fail("effective_to must be a valid date-time");
    effectiveToProvided = true;
    effectiveTo = to.value;
    columns.push("effective_to");
    values.push(to.value);
  }

  if ("source_url" in r) {
    if (r.source_url === null) {
      columns.push("source_url");
      values.push(null);
    } else {
      const res = validateSourceUrl(r.source_url);
      if (!res.ok) return fail(res.error);
      columns.push("source_url");
      values.push(res.value);
    }
  }

  let isEnabledProvided = false;
  let isEnabled = false;
  if (r.is_enabled !== undefined) {
    if (typeof r.is_enabled !== "boolean") return fail("is_enabled must be a boolean");
    isEnabledProvided = true;
    isEnabled = r.is_enabled;
    columns.push("is_enabled");
    values.push(r.is_enabled ? 1 : 0);
  }

  if (columns.length === 0) {
    return fail("At least one updatable field is required");
  }

  return {
    ok: true,
    value: { columns, values, effectiveToProvided, effectiveTo, isEnabledProvided, isEnabled },
  };
}
