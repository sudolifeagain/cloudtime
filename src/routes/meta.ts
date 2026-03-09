import { Hono } from "hono";
import type { Env } from "../types";
import type { components } from "../types/generated";
import { EDITORS } from "../data/editors";
import { LANGUAGES } from "../data/languages";
import { resolveStatsRange } from "../utils/stats-range";
import { formatDigital, formatHumanReadable, isValidTimezone } from "../utils/time-format";
import { checkUpToDate } from "../utils/aggregation-status";

type GlobalStats = components["schemas"]["GlobalStats"];
type SummaryItem = components["schemas"]["SummaryItem"];

declare const __APP_VERSION__: string;

const meta = new Hono<{ Bindings: Env }>();

// ─── GET /meta ────────────────────────────────────────────

meta.get("/meta", (c) => {
  const ip = c.req.header("CF-Connecting-IP")
    ?? c.req.header("X-Real-IP")
    ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim()
    ?? "";
  return c.json({ data: { ip, version: __APP_VERSION__ } });
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
  const tz = c.req.query("timezone");
  if (tz && !isValidTimezone(tz)) {
    return c.json({ error: "Invalid timezone. Use IANA format (e.g. Asia/Tokyo)" }, 400);
  }
  const resolved = resolveStatsRange(rangeParam, tz);
  if (!resolved) {
    return c.json({ error: "Invalid range. Use: last_7_days, last_30_days, last_6_months, last_year, all_time, YYYY, or YYYY-MM" }, 400);
  }

  // Check KV cache (5 min TTL)
  const cacheKey = `global-stats:${rangeParam}:${tz ?? "UTC"}`;
  const cached = await c.env.KV.get(cacheKey, "json") as { data: GlobalStats; status: number } | null;
  if (cached) {
    if (cached.status === 202) {
      return c.json({ data: cached.data, message: "Stats are being calculated" }, 202);
    }
    return c.json({ data: cached.data });
  }

  try {
    // Aggregate in SQL — only aggregated rows come back, not raw data
    // GROUP BY 1 ensures NULL and literal 'Unknown' are merged into one group
    type TotalRow = { total_seconds: number; min_date: string | null };
    type DimRow = { name: string; total_seconds: number };

    const where = "WHERE date >= ? AND date <= ?";
    const binds = [resolved.start, resolved.end];

    const [totalResult, catResult, langResult, editorResult, osResult] = await c.env.DB.batch([
      c.env.DB.prepare(`SELECT COALESCE(SUM(total_seconds), 0) AS total_seconds, MIN(date) AS min_date FROM summaries ${where}`).bind(...binds),
      c.env.DB.prepare(`SELECT COALESCE(NULLIF(category, ''), 'Unknown') AS name, SUM(total_seconds) AS total_seconds FROM summaries ${where} GROUP BY 1 ORDER BY total_seconds DESC`).bind(...binds),
      c.env.DB.prepare(`SELECT COALESCE(NULLIF(language, ''), 'Unknown') AS name, SUM(total_seconds) AS total_seconds FROM summaries ${where} GROUP BY 1 ORDER BY total_seconds DESC`).bind(...binds),
      c.env.DB.prepare(`SELECT COALESCE(NULLIF(editor, ''), 'Unknown') AS name, SUM(total_seconds) AS total_seconds FROM summaries ${where} GROUP BY 1 ORDER BY total_seconds DESC`).bind(...binds),
      c.env.DB.prepare(`SELECT COALESCE(NULLIF(operating_system, ''), 'Unknown') AS name, SUM(total_seconds) AS total_seconds FROM summaries ${where} GROUP BY 1 ORDER BY total_seconds DESC`).bind(...binds),
    ]);

    const totalRow = totalResult.results[0] as TotalRow | undefined;
    const totalSeconds = totalRow?.total_seconds ?? 0;

    // Days in range — for all_time, use actual first data date instead of 1970-01-01
    const rangeStart = totalRow?.min_date && rangeParam === "all_time"
      ? totalRow.min_date
      : resolved.start;
    const startMs = new Date(rangeStart + "T00:00:00Z").getTime();
    const endMs = new Date(resolved.end + "T00:00:00Z").getTime();
    const daysInRange = Math.max(1, Math.floor((endMs - startMs) / 86400000) + 1);
    const dailyAverage = totalSeconds / daysInRange;

    // Convert DB rows to SummaryItem arrays
    function toSummaryItems(rows: DimRow[], grandTotal: number): SummaryItem[] {
      return rows.map((row) => {
        const ts = row.total_seconds;
        return {
          name: row.name,
          total_seconds: ts,
          percent: grandTotal > 0 ? Math.round((ts / grandTotal) * 10000) / 100 : 0,
          digital: formatDigital(ts),
          text: formatHumanReadable(ts),
          hours: Math.floor(ts / 3600),
          minutes: Math.floor((ts % 3600) / 60),
          seconds: Math.floor(ts % 60),
        };
      });
    }

    const isUpToDate = await checkUpToDate(c.env.DB);

    const data: GlobalStats = {
      total_seconds: totalSeconds,
      total_seconds_including_other_language: totalSeconds,
      daily_average: dailyAverage,
      human_readable_total: formatHumanReadable(totalSeconds),
      human_readable_daily_average: formatHumanReadable(dailyAverage),
      categories: toSummaryItems(catResult.results as DimRow[], totalSeconds),
      languages: toSummaryItems(langResult.results as DimRow[], totalSeconds),
      editors: toSummaryItems(editorResult.results as DimRow[], totalSeconds),
      operating_systems: toSummaryItems(osResult.results as DimRow[], totalSeconds),
      range: {
        start: `${resolved.start}T00:00:00Z`,
        end: `${resolved.end}T23:59:59Z`,
        text: resolved.text,
        timezone: tz ?? "UTC",
      },
    };

    const status = isUpToDate ? 200 : 202;

    // Cache for 5 minutes
    await c.env.KV.put(cacheKey, JSON.stringify({ data, status }), { expirationTtl: 300 });

    if (!isUpToDate) {
      return c.json({ data, message: "Stats are being calculated" }, 202);
    }

    return c.json({ data });
  } catch {
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default meta;
