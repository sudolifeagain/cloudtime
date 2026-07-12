/**
 * AI model price management + usage endpoints (Issue #200, US2/US3).
 *
 * Owner-scoped, effective-dated price rows turn stored AI token facts into
 * API-equivalent estimated costs. All routes are owner-only (authMiddleware) and
 * scoped by `user_id`; unknown / cross-user / default rows return 404 on the
 * single-row endpoints so id existence is never leaked. Persistence and the
 * stored-row invariants live in `src/utils/ai/price-store.ts`, shared with the
 * session-authenticated owner dashboard controls (`src/routes/app.tsx`).
 */
import { Hono } from "hono";
import type { AuthEnv } from "../types";
import { authMiddleware, getUserTimezone } from "../middleware/auth";
import { isValidDateTime } from "../utils/datetime";
import { isValidTimezone } from "../utils/time-format";
import {
  rowToAiModelPrice,
  toMs,
  validateCreatePrice,
  validateUpdatePrice,
  type AiModelPriceRow,
} from "../utils/ai/pricing";
import {
  applyPriceUpdate,
  deletePrice,
  fetchPriceRow,
  insertPrice,
  listEnabledPrices,
  listPrices,
} from "../utils/ai/price-store";
import { resolveDefaultPrice } from "../utils/ai/default-prices";
import {
  AI_DAILY_USAGE_SELECT_COLUMNS,
  buildUsageSummary,
  resolveUsageRange,
  type AiDailyUsageRow,
} from "../utils/ai/usage";

const ai = new Hono<AuthEnv>();

ai.use("/ai/usage", authMiddleware);
ai.use("/ai/prices", authMiddleware);
ai.use("/ai/prices/*", authMiddleware);

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
    const rows = await listPrices(c.env.DB, userId, {
      provider,
      model,
      includeDisabled,
      activeOnMs: activeOn !== undefined ? toMs(activeOn) : undefined,
    });
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

  try {
    const result = await insertPrice(c.env.DB, userId, parsed.value);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ data: rowToAiModelPrice(result.row) }, 201);
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

    const result = await applyPriceUpdate(c.env.DB, userId, row, parsed.value);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ data: rowToAiModelPrice(result.row) });
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
    const deleted = await deletePrice(c.env.DB, userId, priceId);
    if (!deleted) return c.json({ error: "Not found" }, 404);
    return c.body(null, 204);
  } catch (err) {
    console.error("DELETE /ai/prices/:price_id error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// GET /ai/usage — owner-only AI coding usage + estimated cost summary (US2).
// Served entirely from the cron-built `ai_daily_usage` rollup (aggregate-then-
// price); never scans raw heartbeats at request time. Owner-only via
// authMiddleware (401 when unauthenticated); in single-user mode the sole
// authenticated user is the owner. authMiddleware sets `Cache-Control: no-store`
// so these cost reads are never cached. Prefer Authorization: Bearer over
// ?api_key= on this endpoint so the key is not exposed in URLs/access logs.
ai.get("/ai/usage", async (c) => {
  const userId = c.get("userId");

  // Aggregation timezone = the owner's profile tz, the fixed tz the rollup `day`
  // keys and price windows were materialized in (FR-008/FR-025). The request
  // `timezone` only anchors "today"/labels the range; it never re-buckets days.
  const aggregationTz = await getUserTimezone(c);

  const tzParam = c.req.query("timezone");
  if (tzParam !== undefined && !isValidTimezone(tzParam)) {
    return c.json({ error: "timezone must be a valid IANA name (e.g. Asia/Tokyo)" }, 400);
  }
  const requestTz = tzParam ?? aggregationTz;

  const range = resolveUsageRange(
    c.req.query("start"),
    c.req.query("end"),
    c.req.query("days"),
    requestTz,
  );
  if (!range.ok) return c.json({ error: range.error }, 400);

  const project = c.req.query("project");

  try {
    let sql =
      `SELECT ${AI_DAILY_USAGE_SELECT_COLUMNS} FROM ai_daily_usage ` +
      "WHERE user_id = ? AND day >= ? AND day <= ?";
    const binds: (string | number)[] = [userId, range.start, range.end];
    if (project !== undefined) {
      sql += " AND project = ?";
      binds.push(project);
    }

    const { results: rows } = await c.env.DB.prepare(sql)
      .bind(...binds)
      .all<AiDailyUsageRow>();

    // Only enabled owner price rows participate in cost estimation.
    const prices = await listEnabledPrices(c.env.DB, userId);
    // Resolve a shipped default for each (provider, model) actually used, so cost
    // estimation covers models the owner has not priced. Owner rows still win in
    // selectEffectivePrice; an unresolved model stays unpriced (missing_price_count).
    const resolved = new Set<string>();
    const defaults: AiModelPriceRow[] = [];
    for (const r of rows) {
      const key = `${r.provider} ${r.model}`;
      if (resolved.has(key)) continue;
      resolved.add(key);
      const d = resolveDefaultPrice(userId, r.provider, r.model);
      if (d) defaults.push(d);
    }

    const summary = buildUsageSummary({
      start: range.start,
      end: range.end,
      timezone: requestTz,
      aggregationTz,
      rows,
      prices: [...prices, ...defaults],
    });

    return c.json({ data: summary });
  } catch (err) {
    console.error("GET /ai/usage error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default ai;
