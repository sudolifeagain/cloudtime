import { Hono } from "hono";
import type { AuthEnv } from "../types";
import type { components } from "../types/generated";
import { authMiddleware } from "../middleware/auth";
import { resolveDateRange, formatDigital, formatHumanReadable } from "../utils/time-format";

type Summary = components["schemas"]["Summary"];
type SummaryItem = components["schemas"]["SummaryItem"];
type GrandTotal = components["schemas"]["GrandTotal"];
type CumulativeTotal = components["schemas"]["CumulativeTotal"];
type DailyAverage = components["schemas"]["DailyAverage"];

type SummaryRow = {
  date: string;
  project: string | null;
  language: string | null;
  editor: string | null;
  operating_system: string | null;
  category: string | null;
  branch: string | null;
  machine: string | null;
  total_seconds: number;
};

const DIMENSIONS = ["project", "language", "editor", "operating_system", "category", "branch", "machine"] as const;
type Dimension = (typeof DIMENSIONS)[number];

const DIMENSION_TO_KEY: Record<Dimension, string> = {
  project: "projects",
  language: "languages",
  editor: "editors",
  operating_system: "operating_systems",
  category: "categories",
  branch: "branches",
  machine: "machines",
};

const summaries = new Hono<AuthEnv>();

summaries.use("/summaries", authMiddleware);

summaries.get("/summaries", async (c) => {
  const range = c.req.query("range");
  const start = c.req.query("start");
  const end = c.req.query("end");
  const project = c.req.query("project");
  const branchesParam = c.req.query("branches");

  const resolved = resolveDateRange(range, start, end);
  if (!resolved) {
    return c.json({ error: "Valid range or start+end dates are required" }, 400);
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

function buildSummary(date: string, rows: SummaryRow[]): Summary {
  // Grand total = sum of all rows' total_seconds for this date
  let grandTotalSeconds = 0;
  for (const row of rows) {
    grandTotalSeconds += row.total_seconds;
  }

  const grand_total: GrandTotal = {
    total_seconds: grandTotalSeconds,
    digital: formatDigital(grandTotalSeconds),
    text: formatHumanReadable(grandTotalSeconds),
    hours: Math.floor(grandTotalSeconds / 3600),
    minutes: Math.floor((grandTotalSeconds % 3600) / 60),
  };

  // Aggregate each dimension
  const dimensionItems: Record<string, SummaryItem[]> = {};
  for (const dim of DIMENSIONS) {
    dimensionItems[DIMENSION_TO_KEY[dim]] = aggregateDimension(rows, dim, grandTotalSeconds);
  }

  return {
    grand_total,
    range: {
      date,
      start: `${date}T00:00:00Z`,
      end: `${date}T23:59:59Z`,
      text: date,
      timezone: "UTC",
    },
    ...dimensionItems,
    entities: [],
    dependencies: [],
  };
}

function aggregateDimension(rows: SummaryRow[], dimension: Dimension, grandTotal: number): SummaryItem[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const name = row[dimension] ?? "Unknown";
    totals.set(name, (totals.get(name) ?? 0) + row.total_seconds);
  }

  // Sort descending by total_seconds
  const items = Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, total_seconds]): SummaryItem => ({
      name,
      total_seconds,
      percent: grandTotal > 0 ? Math.round((total_seconds / grandTotal) * 10000) / 100 : 0,
      digital: formatDigital(total_seconds),
      text: formatHumanReadable(total_seconds),
      hours: Math.floor(total_seconds / 3600),
      minutes: Math.floor((total_seconds % 3600) / 60),
      seconds: Math.floor(total_seconds % 60),
    }));

  return items;
}

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
