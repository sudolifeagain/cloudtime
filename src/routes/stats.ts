import { Hono } from "hono";
import type { AuthEnv } from "../types";
import type { components } from "../types/generated";
import { authMiddleware, getUserTimezone } from "../middleware/auth";
import { formatDigital, formatHumanReadable, getToday, formatDate, isValidTimezone, getEpochBoundsForDate } from "../utils/time-format";
import { resolveStatsRange } from "../utils/stats-range";
import { buildSummary, aggregateDimension, DIMENSIONS, DIMENSION_TO_KEY, type SummaryRow } from "../utils/summary-builder";
import { checkUpToDate } from "../utils/aggregation-status";

type Stats = components["schemas"]["Stats"];
type AllTime = components["schemas"]["AllTime"];
type Duration = components["schemas"]["Duration"];
type Summary = components["schemas"]["Summary"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const stats = new Hono<AuthEnv>();

stats.use("/*", authMiddleware);

// ─── GET /stats/:range ───────────────────────────────────

stats.get("/stats/:range", async (c) => {
  const rangeParam = c.req.param("range");
  const tzParam = c.req.query("timezone");
  if (tzParam && !isValidTimezone(tzParam)) {
    return c.json({ error: "Invalid timezone. Use IANA format (e.g. Asia/Tokyo)" }, 400);
  }
  const tz = tzParam || await getUserTimezone(c);
  const resolved = resolveStatsRange(rangeParam, tz);
  if (!resolved) {
    return c.json({ error: "Invalid range. Use: last_7_days, last_30_days, last_6_months, last_year, all_time, YYYY, or YYYY-MM" }, 400);
  }

  const userId = c.get("userId");

  const sql = `SELECT date, project, language, editor, operating_system, category, branch, machine, total_seconds
    FROM summaries WHERE user_id = ? AND date >= ? AND date <= ?`;
  const { results } = await c.env.DB.prepare(sql)
    .bind(userId, resolved.start, resolved.end)
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

  // Dimension breakdowns (across all dates)
  const dimensionItems: Record<string, ReturnType<typeof aggregateDimension>> = {};
  for (const dim of DIMENSIONS) {
    dimensionItems[DIMENSION_TO_KEY[dim]] = aggregateDimension(results, dim, totalSeconds);
  }

  // Best day
  const dailyTotals = new Map<string, number>();
  for (const row of results) {
    dailyTotals.set(row.date, (dailyTotals.get(row.date) ?? 0) + row.total_seconds);
  }

  let bestDay: { date?: string; total_seconds?: number; text?: string } | undefined;
  let bestDaySeconds = 0;
  for (const [date, seconds] of dailyTotals) {
    if (seconds > bestDaySeconds) {
      bestDaySeconds = seconds;
      bestDay = { date, total_seconds: seconds, text: formatHumanReadable(seconds) };
    }
  }

  const isUpToDate = await checkUpToDate(c.env.DB);

  const data: Stats = {
    total_seconds: totalSeconds,
    total_seconds_including_other_language: totalSeconds,
    daily_average: dailyAverage,
    daily_average_including_other_language: dailyAverage,
    human_readable_total: formatHumanReadable(totalSeconds),
    human_readable_total_including_other_language: formatHumanReadable(totalSeconds),
    human_readable_daily_average: formatHumanReadable(dailyAverage),
    human_readable_daily_average_including_other_language: formatHumanReadable(dailyAverage),
    ...dimensionItems,
    dependencies: [],
    best_day: bestDay,
    range: {
      start: `${resolved.start}T00:00:00Z`,
      end: `${resolved.end}T23:59:59Z`,
      text: resolved.text,
      timezone: tz,
    },
    status: isUpToDate ? "ok" : "pending_update",
    is_already_updating: false,
    is_up_to_date: isUpToDate,
  };

  return c.json({ data }, isUpToDate ? 200 : 202);
});

// ─── GET /status_bar/today ───────────────────────────────

stats.get("/status_bar/today", async (c) => {
  const userId = c.get("userId");
  const tzParam = c.req.query("timezone");
  if (tzParam && !isValidTimezone(tzParam)) {
    return c.json({ error: "Invalid timezone. Use IANA format (e.g. Asia/Tokyo)" }, 400);
  }
  const tz = tzParam || await getUserTimezone(c);
  const today = formatDate(getToday(tz));
  const cacheKey = `statusbar:${userId}:${today}:${tz}`;

  // Check KV cache
  const cached = await c.env.KV.get(cacheKey, "json") as { data: Summary; cached_at: string } | null;
  if (cached) {
    return c.json(cached);
  }
  const sql = `SELECT date, project, language, editor, operating_system, category, branch, machine, total_seconds
    FROM summaries WHERE user_id = ? AND date = ?`;
  const { results } = await c.env.DB.prepare(sql)
    .bind(userId, today)
    .all<SummaryRow>();

  const summary = buildSummary(today, results, tz);
  const response = { data: summary, cached_at: new Date().toISOString() };

  await c.env.KV.put(cacheKey, JSON.stringify(response), { expirationTtl: 60 });

  return c.json(response);
});

// ─── GET /all_time_since_today ───────────────────────────

stats.get("/all_time_since_today", async (c) => {
  const userId = c.get("userId");
  const project = c.req.query("project");
  const tzParam = c.req.query("timezone");
  if (tzParam && !isValidTimezone(tzParam)) {
    return c.json({ error: "Invalid timezone. Use IANA format (e.g. Asia/Tokyo)" }, 400);
  }
  const tz = tzParam || await getUserTimezone(c);

  let sql = "SELECT COALESCE(SUM(total_seconds), 0) as total_seconds, MIN(date) as first_date FROM summaries WHERE user_id = ?";
  const params: (string | number)[] = [userId];

  if (project) {
    sql += " AND project = ?";
    params.push(project);
  }

  const row = await c.env.DB.prepare(sql)
    .bind(...params)
    .first<{ total_seconds: number; first_date: string | null }>();

  const totalSeconds = row?.total_seconds ?? 0;
  const today = formatDate(getToday(tz));
  const firstDate = row?.first_date ?? today;
  const isUpToDate = await checkUpToDate(c.env.DB);

  const data: AllTime = {
    total_seconds: totalSeconds,
    text: formatHumanReadable(totalSeconds),
    digital: formatDigital(totalSeconds),
    is_up_to_date: isUpToDate,
    range: {
      start: `${firstDate}T00:00:00Z`,
      end: `${today}T23:59:59Z`,
      text: "All Time",
      timezone: tz,
    },
    ...(project ? { project } : {}),
  };

  return c.json({ data });
});

// ─── GET /durations ──────────────────────────────────────

type HeartbeatRow = {
  time: number;
  entity: string;
  project: string | null;
  language: string | null;
  branch: string | null;
  category: string | null;
  machine: string | null;
  editor: string | null;
  operating_system: string | null;
  is_write: number;
};

stats.get("/durations", async (c) => {
  const date = c.req.query("date");
  if (!date || !DATE_RE.test(date)) {
    return c.json({ error: "Valid date parameter (YYYY-MM-DD) is required" }, 400);
  }

  const userId = c.get("userId");
  const project = c.req.query("project");
  const branchesParam = c.req.query("branches");
  const sliceBy = c.req.query("slice_by") ?? "project";
  const tzParam = c.req.query("timezone");
  if (tzParam && !isValidTimezone(tzParam)) {
    return c.json({ error: "Invalid timezone. Use IANA format (e.g. Asia/Tokyo)" }, 400);
  }
  const tz = tzParam || await getUserTimezone(c);

  // Convert date to UNIX epoch range in user's timezone
  const { start: dayStart, end: dayEnd } = getEpochBoundsForDate(date, tz);

  // Build query
  let sql = `SELECT time, entity, project, language, branch, category, machine, editor, operating_system, is_write
    FROM heartbeats WHERE user_id = ? AND time >= ? AND time < ?`;
  const params: (string | number)[] = [userId, dayStart, dayEnd];

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

  sql += " ORDER BY time ASC";

  // Fetch heartbeats and user timeout in parallel
  const [heartbeatsResult, userRow] = await Promise.all([
    c.env.DB.prepare(sql).bind(...params).all<HeartbeatRow>(),
    c.env.DB.prepare("SELECT timeout FROM users WHERE id = ?").bind(userId).first<{ timeout: number }>(),
  ]);

  const heartbeats = heartbeatsResult.results;
  const timeout = (userRow?.timeout ?? 15) * 60; // minutes to seconds

  // Build duration segments
  const durations: Duration[] = [];
  const branchSet = new Set<string>();

  if (heartbeats.length > 0) {
    let segStart = heartbeats[0];
    let segDuration = 0;

    for (let i = 1; i < heartbeats.length; i++) {
      const curr = heartbeats[i];
      const gap = curr.time - heartbeats[i - 1].time;
      const sliceChanged = getSliceValue(curr, sliceBy) !== getSliceValue(segStart, sliceBy);

      if (gap > timeout || sliceChanged) {
        // Emit previous segment
        durations.push(buildDuration(segStart, segDuration));
        segStart = curr;
        segDuration = 0;
      } else {
        segDuration += gap;
      }

      if (curr.branch) branchSet.add(curr.branch);
    }

    // Emit final segment
    durations.push(buildDuration(segStart, segDuration));
    if (segStart.branch) branchSet.add(segStart.branch);
  }

  return c.json({
    data: durations,
    branches: Array.from(branchSet).sort(),
    start: date,
    end: date,
    timezone: tz,
  });
});

function getSliceValue(hb: HeartbeatRow, sliceBy: string): string {
  switch (sliceBy) {
    case "entity": return hb.entity ?? "";
    case "language": return hb.language ?? "";
    case "dependencies": return "";
    case "operating_system": return hb.operating_system ?? "";
    case "editor": return hb.editor ?? "";
    case "category": return hb.category ?? "";
    case "machine": return hb.machine ?? "";
    case "project":
    default: return hb.project ?? "";
  }
}

function buildDuration(hb: HeartbeatRow, duration: number): Duration {
  return {
    project: hb.project ?? "Unknown",
    time: hb.time,
    duration,
    entity: hb.entity,
    language: hb.language ?? undefined,
    branch: hb.branch ?? undefined,
    category: (hb.category as Duration["category"]) ?? undefined,
    machine: hb.machine ?? undefined,
  };
}

export default stats;
