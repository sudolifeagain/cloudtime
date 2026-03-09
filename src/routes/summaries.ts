import { Hono } from "hono";
import type { AuthEnv } from "../types";
import type { components } from "../types/generated";
import { authMiddleware } from "../middleware/auth";
import { resolveDateRange, formatDigital, formatHumanReadable } from "../utils/time-format";
import { buildSummary, type SummaryRow } from "../utils/summary-builder";

type Summary = components["schemas"]["Summary"];
type CumulativeTotal = components["schemas"]["CumulativeTotal"];
type DailyAverage = components["schemas"]["DailyAverage"];

const MAX_BRANCHES = 25;
const MAX_DAYS = 366;

const summaries = new Hono<AuthEnv>();

summaries.use("/summaries", authMiddleware);

summaries.get("/summaries", async (c) => {
  const range = c.req.query("range");
  const start = c.req.query("start");
  const end = c.req.query("end");
  const project = c.req.query("project");
  const branchesParam = c.req.query("branches");
  const tz = c.req.query("timezone");

  const resolved = resolveDateRange(range, start, end, tz);
  if (!resolved) {
    return c.json({ error: "Valid range or start+end dates are required" }, 400);
  }

  // Guard against unbounded date ranges
  const daySpan = (new Date(resolved.end + "T00:00:00Z").getTime() - new Date(resolved.start + "T00:00:00Z").getTime()) / 86400000 + 1;
  if (daySpan > MAX_DAYS) {
    return c.json({ error: `Date range must not exceed ${MAX_DAYS} days` }, 400);
  }

  const userId = c.get("userId");

  // Build query with optional filters
  let sql = "SELECT date, project, language, editor, operating_system, category, branch, machine, total_seconds FROM summaries WHERE user_id = ? AND date >= ? AND date <= ?";
  const params: (string | number)[] = [userId, resolved.start, resolved.end];

  if (project) {
    sql += " AND project = ?";
    params.push(project);
  }

  if (branchesParam) {
    const branchList = branchesParam.split(",").map((b) => b.trim()).filter(Boolean);
    if (branchList.length > MAX_BRANCHES) {
      return c.json({ error: `Maximum ${MAX_BRANCHES} branches allowed` }, 400);
    }
    if (branchList.length > 0) {
      sql += ` AND branch IN (${branchList.map(() => "?").join(", ")})`;
      params.push(...branchList);
    }
  }

  try {
    const { results } = await c.env.DB.prepare(sql).bind(...params).all<SummaryRow>();

    // Group rows by date
    const rowsByDate = new Map<string, SummaryRow[]>();
    for (const row of results) {
      const existing = rowsByDate.get(row.date);
      if (existing) {
        existing.push(row);
      } else {
        rowsByDate.set(row.date, [row]);
      }
    }

    // Generate all dates in range
    const dates = generateDateRange(resolved.start, resolved.end);

    let cumulativeSeconds = 0;
    const data: Summary[] = dates.map((date) => {
      const rows = rowsByDate.get(date) ?? [];
      const summary = buildSummary(date, rows);
      cumulativeSeconds += summary.grand_total.total_seconds;
      return summary;
    });

    const cumulative_total: CumulativeTotal = {
      seconds: cumulativeSeconds,
      text: formatHumanReadable(cumulativeSeconds),
      digital: formatDigital(cumulativeSeconds),
    };

    const daily_average: DailyAverage = {
      seconds: dates.length > 0 ? cumulativeSeconds / dates.length : 0,
      text: formatHumanReadable(dates.length > 0 ? cumulativeSeconds / dates.length : 0),
    };

    return c.json({
      data,
      start: resolved.start,
      end: resolved.end,
      cumulative_total,
      daily_average,
    });
  } catch {
    return c.json({ error: "Internal server error" }, 500);
  }
});

function generateDateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const startDate = new Date(start + "T00:00:00Z");
  const endDate = new Date(end + "T00:00:00Z");

  let current = startDate;
  while (current <= endDate) {
    dates.push(current.toISOString().slice(0, 10));
    current = new Date(current.getTime() + 86400000);
  }
  return dates;
}

export default summaries;
