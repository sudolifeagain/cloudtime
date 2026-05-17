/**
 * Pure helpers for Goals chart computation (Issue: specs/100-goals-read/).
 *
 * The route handler resolves a goal, fetches matching summary totals from
 * D1, and assembles a 7-period chart. This module owns the deterministic
 * parts (range boundary math, classification, top-status) so they are
 * unit-testable without D1.
 *
 * Day periods span one local calendar day in the user's profile timezone.
 * Week periods span ISO 8601 Monday-Sunday weeks in the user's profile
 * timezone. The cron aggregator buckets `summaries.date` in that same
 * timezone, so the chart can match by date strings directly.
 */
import { getDateForTimestamp, getEpochBoundsForDate } from "./time-format";

export type RangeStatus = "success" | "fail" | "pending";

export interface ChartRange {
  date: string;
  start: string;
  end: string;
  text: string;
  timezone: string;
}

export interface ChartEntry {
  actual_seconds: number;
  goal_seconds: number;
  range: ChartRange;
  range_status: RangeStatus;
}

const CHART_LENGTH = 7;

function isoDateUtc(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

/**
 * Build 7 day-ranges in the user's profile timezone, oldest first.
 * The final entry is "today" in that timezone (used as the pending period).
 */
export function buildDayRanges(
  nowMs: number,
  tz: string,
  count = CHART_LENGTH,
): ChartRange[] {
  const ranges: ChartRange[] = [];
  // Walk backwards from today by subtracting 86_400s from "today's epoch noon"
  // and converting to the user's local date each step — this is robust across
  // DST transitions because we resolve the local date via Intl, not naive math.
  const todayLocal = getDateForTimestamp(nowMs / 1000, tz);
  // Seed the loop with the local "today" string then walk back by computing
  // bounds and stepping the loop pointer 24h earlier in epoch terms.
  const dates: string[] = [todayLocal];
  let cursorEpoch = Math.floor(nowMs / 1000);
  while (dates.length < count) {
    cursorEpoch -= 86_400;
    dates.push(getDateForTimestamp(cursorEpoch, tz));
  }
  dates.reverse(); // oldest first
  for (const date of dates) {
    const bounds = getEpochBoundsForDate(date, tz);
    ranges.push({
      date,
      start: isoDateUtc(bounds.start),
      end: isoDateUtc(bounds.end),
      text: date,
      timezone: tz,
    });
  }
  return ranges;
}

/**
 * Compute the local-timezone ISO 8601 Monday for the given local date.
 * Pure date arithmetic: weekday in 0..6 with Monday=0 .. Sunday=6.
 */
function isoWeekMonday(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  // Use UTC math to avoid the host's local timezone influencing weekday math.
  const utc = new Date(Date.UTC(y, m - 1, d));
  // getUTCDay: Sunday=0..Saturday=6; convert to Mon=0..Sun=6.
  const weekdayMonZero = (utc.getUTCDay() + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - weekdayMonZero);
  return utc.toISOString().slice(0, 10);
}

function addDaysLocal(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

/**
 * Build 7 ISO-week ranges (Monday-Sunday in the user's profile timezone),
 * oldest first. The final entry covers the current week — pending until
 * Sunday 23:59:59.
 */
export function buildWeekRanges(
  nowMs: number,
  tz: string,
  count = CHART_LENGTH,
): ChartRange[] {
  const todayLocal = getDateForTimestamp(nowMs / 1000, tz);
  const thisMonday = isoWeekMonday(todayLocal);
  const mondays: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    mondays.push(addDaysLocal(thisMonday, -7 * i));
  }
  return mondays.map((mondayDate) => {
    const sundayDate = addDaysLocal(mondayDate, 6);
    const startBounds = getEpochBoundsForDate(mondayDate, tz);
    const endBounds = getEpochBoundsForDate(sundayDate, tz);
    return {
      date: mondayDate,
      start: isoDateUtc(startBounds.start),
      end: isoDateUtc(endBounds.end),
      text: `${mondayDate} — ${sundayDate}`,
      timezone: tz,
    };
  });
}

/**
 * Classify one period given its actual total.
 * The current (last) period is always `pending`. Otherwise compare actual
 * to target using `>=` (or `<=` when the goal is inverse — a cap-style goal).
 */
export function classifyRange(
  actual: number,
  target: number,
  isInverse: boolean,
  isCurrent: boolean,
): RangeStatus {
  if (isCurrent) return "pending";
  if (isInverse) return actual <= target ? "success" : "fail";
  return actual >= target ? "success" : "fail";
}

/**
 * Top-level Goal.status — mirror the most recently completed period's
 * status, or force `pending` when the goal is snoozed.
 */
export function topStatus(entries: ChartEntry[], isSnoozed: boolean): RangeStatus {
  if (isSnoozed) return "pending";
  if (entries.length < 2) return "pending";
  return entries[entries.length - 2].range_status;
}

/**
 * Assemble the chart given pre-built ranges and a date → actual_seconds map.
 * Missing dates contribute 0 actual. The last range is treated as pending.
 */
export function buildChart(
  ranges: ChartRange[],
  actualsByDate: Map<string, number>,
  target: number,
  isInverse: boolean,
): ChartEntry[] {
  const lastIdx = ranges.length - 1;
  return ranges.map((range, i) => {
    const actual = actualsByDate.get(range.date) ?? 0;
    return {
      actual_seconds: actual,
      goal_seconds: target,
      range,
      range_status: classifyRange(actual, target, isInverse, i === lastIdx),
    };
  });
}

/**
 * Aggregate per-day summary totals into the buckets of week ranges. The
 * input map is keyed by YYYY-MM-DD (user-tz local date); the returned map
 * is keyed by the Monday of each containing week.
 */
export function rebucketWeekly(
  dailyActuals: Map<string, number>,
  weekRanges: ChartRange[],
): Map<string, number> {
  const weekByDate = new Map<string, number>();
  for (const week of weekRanges) weekByDate.set(week.date, 0);
  for (const [date, seconds] of dailyActuals) {
    const monday = isoWeekMonday(date);
    if (!weekByDate.has(monday)) continue; // outside the 7-week window
    weekByDate.set(monday, (weekByDate.get(monday) ?? 0) + seconds);
  }
  return weekByDate;
}
