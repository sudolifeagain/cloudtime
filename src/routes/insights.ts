/**
 * Coding activity insights (specs/103-insights/).
 *
 * Derives the requested insight_type over a range from the pre-aggregated
 * `summaries` table - one grouped SELECT, then pure in-memory shaping in
 * src/utils/insights.ts. No raw-heartbeat scan, no new table.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../types";
import { authMiddleware, getUserTimezone } from "../middleware/auth";
import { resolveStatsRange } from "../utils/stats-range";
import { buildInsight, INSIGHT_TYPES, type InsightType } from "../utils/insights";
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

  const userId = c.get("userId");
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT date, project, language, editor, operating_system, category, branch, machine,
              SUM(total_seconds) AS total_seconds
         FROM summaries
        WHERE user_id = ? AND date BETWEEN ? AND ?
        GROUP BY date, project, language, editor, operating_system, category, branch, machine`,
    )
      .bind(userId, resolved.start, resolved.end)
      .all<SummaryRow>();

    return c.json({ data: buildInsight(insightType as InsightType, results, resolved, tz) });
  } catch (err) {
    console.error("GET /insights error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default insights;
