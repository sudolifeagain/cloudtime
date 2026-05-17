import { Hono } from "hono";
import type { AuthEnv } from "../types";
import type { components } from "../types/generated";
import { authMiddleware } from "../middleware/auth";
import {
  buildChart,
  buildDayRanges,
  buildWeekRanges,
  rebucketWeekly,
  topStatus,
  type ChartEntry,
  type ChartRange,
} from "../utils/goal-chart";

type Goal = components["schemas"]["Goal"];
type GoalWithChart = components["schemas"]["GoalWithChart"];

interface GoalRow {
  id: string;
  user_id: string;
  title: string;
  type: string;
  delta: string;
  target_seconds: number;
  is_enabled: number;
  is_snoozed: number;
  is_inverse: number;
  languages: string | null;
  editors: string | null;
  projects: string | null;
  created_at: string;
  modified_at: string;
}

interface GoalRowWithTimezone extends GoalRow {
  timezone: string;
}

const VALID_TYPES = new Set(["coding", "languages", "editors", "projects"]);
const VALID_DELTAS = new Set(["day", "week"]);

function parseFilterArray(raw: string | null, goalId: string, column: string): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (Array.isArray(value)) {
      return value.filter((v): v is string => typeof v === "string");
    }
    console.warn(`[goals] non-array ${column} for goal=${goalId}; treating as []`);
    return [];
  } catch {
    console.warn(`[goals] invalid JSON in ${column} for goal=${goalId}; treating as []`);
    return [];
  }
}

function rowToGoal(row: GoalRow): Goal {
  const rawType = VALID_TYPES.has(row.type) ? row.type : "coding";
  const rawDelta = VALID_DELTAS.has(row.delta) ? row.delta : "day";
  return {
    id: row.id,
    title: row.title,
    type: rawType as Goal["type"],
    delta: rawDelta as Goal["delta"],
    target_seconds: row.target_seconds,
    is_enabled: row.is_enabled === 1,
    is_snoozed: row.is_snoozed === 1,
    is_inverse: row.is_inverse === 1,
    languages: parseFilterArray(row.languages, row.id, "languages"),
    editors: parseFilterArray(row.editors, row.id, "editors"),
    projects: parseFilterArray(row.projects, row.id, "projects"),
    created_at: row.created_at,
    modified_at: row.modified_at,
  };
}

const GOAL_COLUMNS = `id, user_id, title, type, delta, target_seconds,
  is_enabled, is_snoozed, is_inverse, languages, editors, projects,
  created_at, modified_at`;

const goals = new Hono<AuthEnv>();

goals.use("/goals", authMiddleware);
goals.use("/goals/*", authMiddleware);

goals.get("/goals", async (c) => {
  const userId = c.get("userId");
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT ${GOAL_COLUMNS} FROM goals
        WHERE user_id = ?
        ORDER BY created_at ASC`,
    )
      .bind(userId)
      .all<GoalRow>();
    return c.json({ data: results.map(rowToGoal) });
  } catch (err) {
    console.error("GET /goals error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

goals.get("/goals/:goal_id", async (c) => {
  const userId = c.get("userId");
  const goalId = c.req.param("goal_id");

  try {
    const row = await c.env.DB.prepare(
      `SELECT ${GOAL_COLUMNS.split(",").map((col) => `g.${col.trim()}`).join(", ")},
              u.timezone AS timezone
         FROM goals g
         JOIN users u ON u.id = g.user_id
        WHERE g.id = ? AND g.user_id = ?`,
    )
      .bind(goalId, userId)
      .first<GoalRowWithTimezone>();

    if (!row) {
      return c.json({ error: "Not found" }, 404);
    }

    const goal = rowToGoal(row);
    const tz = row.timezone || "UTC";

    // Pull the relevant filter array given goal type.
    let filterValues: string[] = [];
    let filterColumn: "language" | "editor" | "project" | null = null;
    switch (goal.type) {
      case "languages":
        filterValues = goal.languages ?? [];
        filterColumn = "language";
        break;
      case "editors":
        filterValues = goal.editors ?? [];
        filterColumn = "editor";
        break;
      case "projects":
        filterValues = goal.projects ?? [];
        filterColumn = "project";
        break;
      default:
        filterColumn = null;
    }

    // Filtered goal with an empty allowlist matches nothing — skip the
    // summaries scan entirely and report zeros.
    const filterMatchesNothing = filterColumn !== null && filterValues.length === 0;

    // 7 ranges in the user's timezone. For weeks we also need the
    // underlying daily totals across the 49-day window so we can re-bucket.
    const nowMs = Date.now();
    const ranges: ChartRange[] = goal.delta === "week"
      ? buildWeekRanges(nowMs, tz)
      : buildDayRanges(nowMs, tz);

    // Span queried in D1: from the oldest range's date to the last range's
    // effective end-date (for weeks, the Sunday of the most recent week).
    const startDate = ranges[0].date;
    const endDate = goal.delta === "week"
      ? // last range is the current week's Monday; query through current local date
        addDaysIsoUtc(ranges[ranges.length - 1].date, 6)
      : ranges[ranges.length - 1].date;

    let actualsByDate = new Map<string, number>();
    if (!filterMatchesNothing) {
      const placeholders = filterValues.map(() => "?").join(",");
      const filterClause = filterColumn !== null
        ? ` AND ${filterColumn} IN (${placeholders})`
        : "";
      const sql =
        `SELECT date, SUM(total_seconds) AS actual_seconds
           FROM summaries
          WHERE user_id = ?
            AND date BETWEEN ? AND ?` + filterClause +
        ` GROUP BY date`;
      const binds: (string | number)[] = [userId, startDate, endDate, ...filterValues];
      const { results } = await c.env.DB.prepare(sql)
        .bind(...binds)
        .all<{ date: string; actual_seconds: number }>();
      for (const r of results) {
        actualsByDate.set(r.date, Number(r.actual_seconds) || 0);
      }
    }

    // For week goals, re-bucket the per-day map into per-Monday totals.
    const bucketedActuals = goal.delta === "week"
      ? rebucketWeekly(actualsByDate, ranges)
      : actualsByDate;

    const chart: ChartEntry[] = buildChart(
      ranges,
      bucketedActuals,
      goal.target_seconds ?? 0,
      goal.is_inverse ?? false,
    );

    const response: GoalWithChart = {
      ...goal,
      chart_data: chart,
      status: topStatus(chart, goal.is_snoozed ?? false),
    };

    return c.json({ data: response });
  } catch (err) {
    console.error("GET /goals/:goal_id error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

function addDaysIsoUtc(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

export default goals;
