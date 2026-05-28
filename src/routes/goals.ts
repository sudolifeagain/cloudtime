import { Hono } from "hono";
import type { AuthEnv } from "../types";
import type { components } from "../types/generated";
import { authMiddleware } from "../middleware/auth";
import { isValidTimezone } from "../utils/time-format";
import { normalizeDateTime } from "../utils/user";
import { validateGoalInput, validateGoalUpdate, type GoalType } from "../utils/goal-input";
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
    created_at: normalizeDateTime(row.created_at),
    modified_at: normalizeDateTime(row.modified_at),
  };
}

const GOAL_COLUMNS = `id, user_id, title, type, delta, target_seconds,
  is_enabled, is_snoozed, is_inverse, languages, editors, projects,
  created_at, modified_at`;

/** Encode a filter array as JSON TEXT, or NULL when empty. */
function jsonOrNull(values: string[]): string | null {
  return values.length > 0 ? JSON.stringify(values) : null;
}

/** Fetch a single goal row scoped to its owner; null when absent or not owned. */
async function selectGoalRow(
  db: D1Database,
  goalId: string,
  userId: string,
): Promise<GoalRow | null> {
  return db
    .prepare(`SELECT ${GOAL_COLUMNS} FROM goals WHERE id = ? AND user_id = ?`)
    .bind(goalId, userId)
    .first<GoalRow>();
}

const goals = new Hono<AuthEnv>();

goals.use("/goals", authMiddleware);
goals.use("/goals/*", authMiddleware);

/**
 * Parse a boolean-ish query parameter. Accepts common truthy/falsy aliases.
 * Returns `undefined` when the param is absent and `null` when the value is
 * unrecognised so the caller can reject with 400.
 */
function parseBoolQuery(raw: string | undefined): boolean | null | undefined {
  if (raw === undefined) return undefined;
  const v = raw.toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return null;
}

goals.get("/goals", async (c) => {
  const userId = c.get("userId");

  // Issue #111: optional filters on the persisted boolean columns.
  const enabledFilter = parseBoolQuery(c.req.query("enabled"));
  const snoozedFilter = parseBoolQuery(c.req.query("snoozed"));
  if (enabledFilter === null) {
    return c.json({ error: "Invalid enabled query parameter; expected true|false" }, 400);
  }
  if (snoozedFilter === null) {
    return c.json({ error: "Invalid snoozed query parameter; expected true|false" }, 400);
  }

  const conditions: string[] = ["user_id = ?"];
  const binds: (string | number)[] = [userId];
  if (enabledFilter !== undefined) {
    conditions.push("is_enabled = ?");
    binds.push(enabledFilter ? 1 : 0);
  }
  if (snoozedFilter !== undefined) {
    conditions.push("is_snoozed = ?");
    binds.push(snoozedFilter ? 1 : 0);
  }

  try {
    const { results } = await c.env.DB.prepare(
      `SELECT ${GOAL_COLUMNS} FROM goals
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at ASC`,
    )
      .bind(...binds)
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
    const candidateTz = row.timezone || "UTC";
    const tz = isValidTimezone(candidateTz) ? candidateTz : "UTC";

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

goals.post("/goals", async (c) => {
  const userId = c.get("userId");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  const parsed = validateGoalInput(body);
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, 400);
  }
  const g = parsed.value;
  const id = crypto.randomUUID();

  try {
    await c.env.DB.prepare(
      `INSERT INTO goals (id, user_id, title, type, delta, target_seconds,
         is_enabled, is_snoozed, is_inverse, languages, editors, projects)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        userId,
        g.title,
        g.type,
        g.delta,
        g.target_seconds,
        g.is_enabled ? 1 : 0,
        g.is_snoozed ? 1 : 0,
        g.is_inverse ? 1 : 0,
        jsonOrNull(g.languages),
        jsonOrNull(g.editors),
        jsonOrNull(g.projects),
      )
      .run();

    const row = await selectGoalRow(c.env.DB, id, userId);
    if (!row) {
      console.error("POST /goals error: inserted goal not found on re-read", id);
      return c.json({ error: "Internal server error" }, 500);
    }
    return c.json({ data: rowToGoal(row) }, 201);
  } catch (err) {
    console.error("POST /goals error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

goals.patch("/goals/:goal_id", async (c) => {
  const userId = c.get("userId");
  const goalId = c.req.param("goal_id");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  try {
    const existing = await selectGoalRow(c.env.DB, goalId, userId);
    if (!existing) {
      return c.json({ error: "Not found" }, 404);
    }
    const existingType = (VALID_TYPES.has(existing.type) ? existing.type : "coding") as GoalType;

    const parsed = validateGoalUpdate(body, existingType);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }
    const v = parsed.value;

    // Build the SET clause from a fixed column allowlist — column names are
    // never taken from user input, only the bound values are.
    const sets: string[] = [];
    const binds: (string | number | null)[] = [];
    if (v.title !== undefined) {
      sets.push("title = ?");
      binds.push(v.title);
    }
    if (v.target_seconds !== undefined) {
      sets.push("target_seconds = ?");
      binds.push(v.target_seconds);
    }
    if (v.is_enabled !== undefined) {
      sets.push("is_enabled = ?");
      binds.push(v.is_enabled ? 1 : 0);
    }
    if (v.is_snoozed !== undefined) {
      sets.push("is_snoozed = ?");
      binds.push(v.is_snoozed ? 1 : 0);
    }
    if (v.is_inverse !== undefined) {
      sets.push("is_inverse = ?");
      binds.push(v.is_inverse ? 1 : 0);
    }
    if (v.languages !== undefined) {
      sets.push("languages = ?");
      binds.push(jsonOrNull(v.languages));
    }
    if (v.editors !== undefined) {
      sets.push("editors = ?");
      binds.push(jsonOrNull(v.editors));
    }
    if (v.projects !== undefined) {
      sets.push("projects = ?");
      binds.push(jsonOrNull(v.projects));
    }
    sets.push("modified_at = datetime('now')");
    binds.push(goalId, userId);

    await c.env.DB.prepare(
      `UPDATE goals SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`,
    )
      .bind(...binds)
      .run();

    const row = await selectGoalRow(c.env.DB, goalId, userId);
    if (!row) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json({ data: rowToGoal(row) });
  } catch (err) {
    console.error("PATCH /goals/:goal_id error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

goals.delete("/goals/:goal_id", async (c) => {
  const userId = c.get("userId");
  const goalId = c.req.param("goal_id");

  try {
    const res = await c.env.DB.prepare(
      `DELETE FROM goals WHERE id = ? AND user_id = ?`,
    )
      .bind(goalId, userId)
      .run();

    if (res.meta.changes === 0) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.body(null, 204);
  } catch (err) {
    console.error("DELETE /goals/:goal_id error:", err);
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
