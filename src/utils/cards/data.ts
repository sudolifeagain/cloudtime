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

// 53 columns covers a full trailing year plus the current partial week, matching
// a contribution-graph layout.
const HEATMAP_WEEKS = 53;

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

  const { results } = await db
    .prepare(
      "SELECT date, SUM(total_seconds) AS seconds FROM summaries WHERE user_id = ? AND date >= ? AND date < ? GROUP BY date",
    )
    .bind(userId, startStr, todayStr)
    .all<{ date: string; seconds: number }>();

  const dayTotals = new Map<string, number>();
  let totalSeconds = 0;
  for (const row of results) {
    dayTotals.set(row.date, row.seconds);
    totalSeconds += row.seconds;
  }

  const todaySeconds = await computeTodaySeconds(db, userId, tz, todayStr, timeoutMinutes);
  if (todaySeconds > 0) {
    dayTotals.set(todayStr, todaySeconds);
    totalSeconds += todaySeconds;
  }

  return { dayTotals, todayStr, totalSeconds };
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
