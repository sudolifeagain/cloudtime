// Data builders for embeddable cards (spec 160).
//
// Past days are read from the pre-aggregated daily `summaries` (cheap, indexed).
// The current local day is computed on demand from raw heartbeats so the latest
// cell reflects activity recorded since the last hourly aggregation run
// (FR-002), bounded to one local day to stay within the Workers CPU budget.

import { addDays, formatDate, getEpochBoundsForDate, getToday } from "../time-format";

export interface HeatmapData {
  /** date (YYYY-MM-DD in the user's timezone) -> coding seconds */
  dayTotals: Map<string, number>;
  todayStr: string;
  totalSeconds: number;
}

export interface StreakStats {
  trackedDays: number;
  currentStreak: number;
  longestStreak: number;
}

export interface StreakData extends StreakStats {
  todayStr: string;
  totalSeconds: number;
}

// 53 columns covers a full trailing year plus the current partial week, matching
// a contribution-graph layout.
const HEATMAP_WEEKS = 53;
const STREAK_DAYS = 365;

export interface CardRange {
  key: string;
  days: number;
  label: string;
}

const CARD_RANGES: Record<string, CardRange> = {
  last_7_days: { key: "last_7_days", days: 7, label: "the last 7 days" },
  last_30_days: { key: "last_30_days", days: 30, label: "the last 30 days" },
  last_6_months: { key: "last_6_months", days: 183, label: "the last 6 months" },
  last_year: { key: "last_year", days: STREAK_DAYS, label: "the last year" },
};

export function resolveCardRange(range?: string): CardRange {
  if (range && Object.prototype.hasOwnProperty.call(CARD_RANGES, range)) {
    return CARD_RANGES[range];
  }
  return CARD_RANGES.last_year;
}

export async function getHeatmapData(
  db: D1Database,
  userId: string,
  tz: string,
  timeoutMinutes: number,
): Promise<HeatmapData> {
  const today = getToday(tz);
  const todayStr = formatDate(today);
  const todayDow = today.getUTCDay(); // 0=Sun..6=Sat
  const totalDays = (HEATMAP_WEEKS - 1) * 7 + todayDow + 1;
  const startStr = formatDate(addDays(today, -(totalDays - 1)));

  const { dayTotals, totalSeconds: pastSeconds } = await loadSummaryDayTotals(
    db,
    userId,
    startStr,
    todayStr,
  );
  let totalSeconds = pastSeconds;

  const todaySeconds = await computeTodaySeconds(db, userId, tz, todayStr, timeoutMinutes);
  if (todaySeconds > 0) {
    dayTotals.set(todayStr, todaySeconds);
    totalSeconds += todaySeconds;
  }

  return { dayTotals, todayStr, totalSeconds };
}

export async function getStreakData(
  db: D1Database,
  userId: string,
  tz: string,
  timeoutMinutes: number,
  rangeDays = STREAK_DAYS,
): Promise<StreakData> {
  const today = getToday(tz);
  const todayStr = formatDate(today);
  const days = Math.max(1, Math.floor(rangeDays));
  const startStr = formatDate(addDays(today, -(days - 1)));

  const { dayTotals, totalSeconds: pastSeconds } = await loadSummaryDayTotals(
    db,
    userId,
    startStr,
    todayStr,
  );
  let totalSeconds = pastSeconds;

  const todaySeconds = await computeTodaySeconds(db, userId, tz, todayStr, timeoutMinutes);
  if (todaySeconds > 0) {
    dayTotals.set(todayStr, todaySeconds);
    totalSeconds += todaySeconds;
  }

  return {
    todayStr,
    totalSeconds,
    ...calculateStreakStats(dayTotals, todayStr),
  };
}

export function calculateStreakStats(dayTotals: Map<string, number>, todayStr: string): StreakStats {
  const activeDays = new Set<string>();
  for (const [date, seconds] of dayTotals) {
    if (seconds > 0) activeDays.add(date);
  }

  const sorted = [...activeDays].filter((date) => parseUtcDate(date) !== null).sort();
  const trackedDays = sorted.length;
  let longestStreak = 0;
  let run = 0;
  let previous: Date | null = null;

  for (const dateStr of sorted) {
    const current = parseUtcDate(dateStr);
    if (!current) continue;
    if (previous && formatDate(addDays(previous, 1)) === dateStr) {
      run += 1;
    } else {
      run = 1;
    }
    longestStreak = Math.max(longestStreak, run);
    previous = current;
  }

  let currentStreak = 0;
  const today = parseUtcDate(todayStr);
  if (today) {
    let cursor = activeDays.has(todayStr) ? today : addDays(today, -1);
    while (activeDays.has(formatDate(cursor))) {
      currentStreak += 1;
      cursor = addDays(cursor, -1);
    }
  }

  return { trackedDays, currentStreak, longestStreak };
}

async function loadSummaryDayTotals(
  db: D1Database,
  userId: string,
  startStr: string,
  endExclusiveStr: string,
): Promise<{ dayTotals: Map<string, number>; totalSeconds: number }> {
  const { results } = await db
    .prepare(
      "SELECT date, SUM(total_seconds) AS seconds FROM summaries WHERE user_id = ? AND date >= ? AND date < ? GROUP BY date",
    )
    .bind(userId, startStr, endExclusiveStr)
    .all<{ date: string; seconds: number | null }>();

  const dayTotals = new Map<string, number>();
  let totalSeconds = 0;
  for (const row of results) {
    const seconds = Number(row.seconds ?? 0);
    dayTotals.set(row.date, seconds);
    totalSeconds += seconds;
  }
  return { dayTotals, totalSeconds };
}

function parseUtcDate(dateStr: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d
  ) {
    return null;
  }
  return parsed;
}

// Sum coding seconds for the user's current local day directly from heartbeats,
// joining gaps shorter than the user's timeout (mirrors the duration logic used
// by /durations and the cron aggregator).
async function computeTodaySeconds(
  db: D1Database,
  userId: string,
  tz: string,
  todayStr: string,
  timeoutMinutes: number,
): Promise<number> {
  const { start, end } = getEpochBoundsForDate(todayStr, tz);
  const { results } = await db
    .prepare(
      "SELECT time FROM heartbeats WHERE user_id = ? AND time >= ? AND time < ? ORDER BY time ASC",
    )
    .bind(userId, start, end)
    .all<{ time: number }>();

  const timeout = timeoutMinutes * 60;
  let total = 0;
  for (let i = 1; i < results.length; i++) {
    const gap = results[i].time - results[i - 1].time;
    if (gap > 0 && gap <= timeout) total += gap;
  }
  return total;
}
