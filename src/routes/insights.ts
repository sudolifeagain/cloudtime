/**
 * Coding activity insights (specs/103-insights/).
 *
 * Derives the requested insight_type over a range from pre-aggregates:
 * most types read `summaries`, while `hours` reads `hourly_summaries`.
 * No raw-heartbeat scan at request time.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../types";
import { authMiddleware, getUserTimezone } from "../middleware/auth";
import { resolveStatsRange } from "../utils/stats-range";
import {
  buildHoursInsight,
  buildInsight,
  INSIGHT_TYPES,
  parseWeekday,
  type HourlyRow,
  type SummaryInsightType,
} from "../utils/insights";
import type { SummaryRow } from "../utils/summary-builder";

const VALID_INSIGHT_TYPES = new Set<string>(INSIGHT_TYPES);

const insights = new Hono<AuthEnv>();

insights.use("/insights/*", authMiddleware);

insights.get("/insights/:insight_type/:range", async (c) => {
  const insightType = c.req.param("insight_type");
  if (!VALID_INSIGHT_TYPES.has(insightType)) {
    return c.json(
      { error: `Invalid insight_type. Use one of: ${INSIGHT_TYPES.join(", ")}` },
      400,
    );
  }

  const tz = await getUserTimezone(c);
  const resolved = resolveStatsRange(c.req.param("range"), tz);
  if (!resolved) {
    return c.json(
      { error: "Invalid range. Use: last_7_days, last_30_days, last_6_months, last_year, all_time, YYYY, or YYYY-MM" },
      400,
    );
  }

  // `weekday` filters the `days` insight only; other types ignore it (incl.
  // invalid values). For `days`, a present-but-unparseable value is a 400.
  let weekdayFilter: number | null = null;
  const weekdayRaw = c.req.query("weekday");
  if (weekdayRaw !== undefined && insightType === "days") {
    weekdayFilter = parseWeekday(weekdayRaw);
    if (weekdayFilter === null) {
      return c.json(
        { error: "Invalid weekday. Use 0-6 (0=Sunday) or a weekday name (sunday-saturday)." },
        400,
      );
    }
  }

  const userId = c.get("userId");
  try {
    // The `hours`-of-day type reads the hour-of-day pre-aggregate instead of
    // `summaries` (day granularity can't answer it). Issue #134.
    if (insightType === "hours") {
      const { results } = await c.env.DB.prepare(
        `SELECT date, hour, total_seconds
           FROM hourly_summaries
          WHERE user_id = ? AND date BETWEEN ? AND ?`,
      )
        .bind(userId, resolved.start, resolved.end)
        .all<HourlyRow>();

      return c.json({ data: buildHoursInsight(results, resolved, tz) });
    }

    const { results } = await c.env.DB.prepare(
      `SELECT date, project, language, editor, operating_system, category, branch, machine,
              SUM(total_seconds) AS total_seconds
         FROM summaries
        WHERE user_id = ? AND date BETWEEN ? AND ?
        GROUP BY date, project, language, editor, operating_system, category, branch, machine`,
    )
      .bind(userId, resolved.start, resolved.end)
      .all<SummaryRow>();

    return c.json({ data: buildInsight(insightType as SummaryInsightType, results, resolved, tz, weekdayFilter) });
  } catch (err) {
    console.error("GET /insights error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default insights;
