import { Hono } from "hono";
import type { Env } from "../types";
import type { components } from "../types/generated";
import { EDITORS } from "../data/editors";
import { LANGUAGES } from "../data/languages";
import { resolveStatsRange } from "../utils/stats-range";
import { aggregateDimension, type SummaryRow } from "../utils/summary-builder";
import { formatHumanReadable } from "../utils/time-format";

type GlobalStats = components["schemas"]["GlobalStats"];

const VERSION = "0.1.0";

const meta = new Hono<{ Bindings: Env }>();

// ─── Helpers ──────────────────────────────────────────────

async function checkUpToDate(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT value FROM meta WHERE key = 'last_aggregated_at'")
    .first<{ value: string }>();
  const lastAggregatedAt = row ? Number(row.value) : 0;
  return (Date.now() / 1000 - lastAggregatedAt) < 7200;
}

// ─── GET /meta ────────────────────────────────────────────

meta.get("/meta", (c) => {
  const ip = c.req.header("CF-Connecting-IP")
    ?? c.req.header("X-Real-IP")
    ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim()
    ?? "";
  return c.json({ data: { ip, version: VERSION } });
});

// ─── GET /editors ─────────────────────────────────────────

meta.get("/editors", (c) => {
  return c.json({ data: EDITORS });
});

// ─── GET /program_languages ──────────────────────────────

meta.get("/program_languages", (c) => {
  return c.json({ data: LANGUAGES });
});

// ─── GET /stats/:range (global stats) ────────────────────

meta.get("/stats/:range", async (c) => {
  const rangeParam = c.req.param("range");
  const resolved = resolveStatsRange(rangeParam);
  if (!resolved) {
    return c.json({ error: "Invalid range. Use: last_7_days, last_30_days, last_6_months, last_year, all_time, YYYY, or YYYY-MM" }, 400);
  }

  try {
    const sql = `SELECT date, project, language, editor, operating_system, category, branch, machine, total_seconds
      FROM summaries WHERE date >= ? AND date <= ?`;
    const { results } = await c.env.DB.prepare(sql)
      .bind(resolved.start, resolved.end)
      .all<SummaryRow>();

    // Total seconds
    let totalSeconds = 0;
    for (const row of results) {
      totalSeconds += row.total_seconds;
    }

    // Days in range
    const startMs = new Date(resolved.start + "T00:00:00Z").getTime();
    const endMs = new Date(resolved.end + "T00:00:00Z").getTime();
    const daysInRange = Math.max(1, Math.floor((endMs - startMs) / 86400000) + 1);
    const dailyAverage = totalSeconds / daysInRange;

    // Dimension breakdowns (only the 4 in GlobalStats schema)
    const GLOBAL_DIMENSIONS = ["category", "language", "editor", "operating_system"] as const;
    const GLOBAL_DIM_KEYS: Record<string, string> = {
      category: "categories",
      language: "languages",
      editor: "editors",
      operating_system: "operating_systems",
    };

    const dimensionItems: Record<string, ReturnType<typeof aggregateDimension>> = {};
    for (const dim of GLOBAL_DIMENSIONS) {
      dimensionItems[GLOBAL_DIM_KEYS[dim]] = aggregateDimension(results, dim, totalSeconds);
    }

    const isUpToDate = await checkUpToDate(c.env.DB);

    const data: GlobalStats = {
      total_seconds: totalSeconds,
      total_seconds_including_other_language: totalSeconds,
      daily_average: dailyAverage,
      human_readable_total: formatHumanReadable(totalSeconds),
      human_readable_daily_average: formatHumanReadable(dailyAverage),
      ...dimensionItems,
      range: {
        start: `${resolved.start}T00:00:00Z`,
        end: `${resolved.end}T23:59:59Z`,
        text: resolved.text,
        timezone: "UTC",
      },
    };

    if (!isUpToDate) {
      return c.json({ data, message: "Stats are being calculated" }, 202);
    }

    return c.json({ data });
  } catch {
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default meta;
