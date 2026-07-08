// Data builders for embeddable cards (spec 160).
//
// Past days are read from the pre-aggregated daily `summaries` (cheap, indexed).
// The current local day is computed on demand from raw heartbeats so the latest
// cell reflects activity recorded since the last hourly aggregation run
// (FR-002), bounded to one local day to stay within the Workers CPU budget.

import { addDays, formatDate, formatHumanReadable, getEpochBoundsForDate, getToday } from "../time-format";
import { formatDays } from "./templates";

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

export interface SummaryCardData {
  todayStr: string;
  totalSeconds: number;
  dailyAverageSeconds: number;
  bestDay: { date: string; seconds: number } | null;
  topLanguage: LanguageShare | null;
}

export interface LanguageShare {
  language: string;
  seconds: number;
  percent: number;
}

export interface LanguagesCardData {
  todayStr: string;
  totalSeconds: number;
  languages: LanguageShare[];
}

// 53 columns covers a full trailing year plus the current partial week, matching
// a contribution-graph layout.
const HEATMAP_WEEKS = 53;
const STREAK_DAYS = 365;
const UNKNOWN_LANGUAGE = "Unknown";

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

export async function getSummaryCardData(
  db: D1Database,
  userId: string,
  tz: string,
  timeoutMinutes: number,
  rangeDays = STREAK_DAYS,
): Promise<SummaryCardData> {
  const { todayStr, startStr, days } = resolveTrailingRange(tz, rangeDays);
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

  const languages = await loadLanguageShares(db, userId, tz, todayStr, startStr, timeoutMinutes);
  const topLanguage = languages[0] ?? null;

  return {
    todayStr,
    totalSeconds,
    dailyAverageSeconds: totalSeconds / days,
    bestDay: findBestDay(dayTotals),
    topLanguage,
  };
}

export async function getLanguagesCardData(
  db: D1Database,
  userId: string,
  tz: string,
  timeoutMinutes: number,
  rangeDays = STREAK_DAYS,
): Promise<LanguagesCardData> {
  const { todayStr, startStr } = resolveTrailingRange(tz, rangeDays);
  const languages = await loadLanguageShares(db, userId, tz, todayStr, startStr, timeoutMinutes);
  const totalSeconds = languages.reduce((sum, language) => sum + language.seconds, 0);
  return { todayStr, totalSeconds, languages };
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

function resolveTrailingRange(tz: string, rangeDays: number): { todayStr: string; startStr: string; days: number } {
  const today = getToday(tz);
  const todayStr = formatDate(today);
  const days = Math.max(1, Math.floor(rangeDays));
  const startStr = formatDate(addDays(today, -(days - 1)));
  return { todayStr, startStr, days };
}

function findBestDay(dayTotals: Map<string, number>): { date: string; seconds: number } | null {
  let best: { date: string; seconds: number } | null = null;
  for (const [date, seconds] of dayTotals) {
    if (seconds <= 0) continue;
    if (!best || seconds > best.seconds || (seconds === best.seconds && date > best.date)) {
      best = { date, seconds };
    }
  }
  return best;
}

async function loadLanguageShares(
  db: D1Database,
  userId: string,
  tz: string,
  todayStr: string,
  startStr: string,
  timeoutMinutes: number,
): Promise<LanguageShare[]> {
  const languageTotals = await loadLanguageTotals(db, userId, startStr, todayStr);
  const todayLanguageTotals = await computeTodayLanguageSeconds(db, userId, tz, todayStr, timeoutMinutes);
  for (const [language, seconds] of todayLanguageTotals) {
    if (language === UNKNOWN_LANGUAGE) continue;
    languageTotals.set(language, (languageTotals.get(language) ?? 0) + seconds);
  }

  const totalSeconds = [...languageTotals.values()].reduce((sum, seconds) => sum + seconds, 0);
  if (totalSeconds <= 0) return [];

  return [...languageTotals.entries()]
    .map(([language, seconds]) => ({
      language,
      seconds,
      percent: (seconds / totalSeconds) * 100,
    }))
    .sort((a, b) => b.seconds - a.seconds || a.language.localeCompare(b.language))
    .slice(0, 5);
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

async function loadLanguageTotals(
  db: D1Database,
  userId: string,
  startStr: string,
  endExclusiveStr: string,
): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT language, SUM(total_seconds) AS seconds
       FROM summaries
       WHERE user_id = ? AND date >= ? AND date < ? AND language IS NOT NULL AND language != ''
       GROUP BY language`,
    )
    .bind(userId, startStr, endExclusiveStr)
    .all<{ language: string; seconds: number | null }>();

  const languageTotals = new Map<string, number>();
  for (const row of results) {
    const seconds = Number(row.seconds ?? 0);
    if (row.language !== UNKNOWN_LANGUAGE && seconds > 0) languageTotals.set(row.language, seconds);
  }
  return languageTotals;
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

// ============================================================
// Badge + composite profile card data (spec 198)
// ============================================================

export interface BadgeRange {
  key: string;
  /** Trailing window in days; null means all recorded history. */
  days: number | null;
  label: string;
  /** Short form used as the default left-hand badge label. */
  shortLabel: string;
}

const BADGE_RANGES: Record<string, BadgeRange> = {
  today: { key: "today", days: 1, label: "today", shortLabel: "today" },
  last_7_days: { key: "last_7_days", days: 7, label: "the last 7 days", shortLabel: "last 7 days" },
  last_30_days: { key: "last_30_days", days: 30, label: "the last 30 days", shortLabel: "last 30 days" },
  last_6_months: { key: "last_6_months", days: 183, label: "the last 6 months", shortLabel: "last 6 months" },
  last_year: { key: "last_year", days: STREAK_DAYS, label: "the last year", shortLabel: "last year" },
  all_time: { key: "all_time", days: null, label: "all time", shortLabel: "all time" },
};

// Unlike resolveCardRange, unknown badge ranges are an error (FR-007), so this
// returns null instead of falling back — the route turns null into a 400.
export function resolveBadgeRange(range: string | undefined, fallbackKey: string): BadgeRange | null {
  if (range === undefined) return BADGE_RANGES[fallbackKey];
  if (Object.prototype.hasOwnProperty.call(BADGE_RANGES, range)) return BADGE_RANGES[range];
  return null;
}

export interface BadgeData {
  label: string;
  value: string;
}

export async function getCodingTimeBadgeData(
  db: D1Database,
  userId: string,
  tz: string,
  timeoutMinutes: number,
  range: BadgeRange,
): Promise<BadgeData> {
  const totalSeconds = await loadRangeTotalSeconds(db, userId, tz, timeoutMinutes, range);
  return { label: range.shortLabel, value: formatHumanReadable(totalSeconds) };
}

export async function getTopLanguageBadgeData(
  db: D1Database,
  userId: string,
  tz: string,
  timeoutMinutes: number,
  range: BadgeRange,
): Promise<BadgeData> {
  const { todayStr, startStr } = resolveBadgeWindow(tz, range);
  const languages = await loadLanguageShares(db, userId, tz, todayStr, startStr, timeoutMinutes);
  const top = languages[0] ?? null;
  return { label: "top language", value: top ? top.language : "No language" };
}

export async function getCurrentStreakBadgeData(
  db: D1Database,
  userId: string,
  tz: string,
  timeoutMinutes: number,
): Promise<BadgeData> {
  const data = await getStreakData(db, userId, tz, timeoutMinutes, STREAK_DAYS);
  return { label: "streak", value: formatDays(data.currentStreak) };
}

interface GoalRow {
  id: string;
  title: string;
  type: string;
  delta: string;
  target_seconds: number;
  languages: string | null;
  editors: string | null;
  projects: string | null;
}

export interface GoalProgressData {
  title: string;
  percent: number;
  actualSeconds: number;
  targetSeconds: number;
  delta: string;
}

/**
 * Local-day start of the goal's current period. Day goals cover today; week
 * goals cover the current ISO 8601 Monday-Sunday week (same convention as
 * the authenticated goals chart in goal-chart.ts).
 */
export function goalPeriodStartDate(todayStr: string, delta: string): string {
  if (delta !== "week") return todayStr;
  const today = parseUtcDate(todayStr);
  if (!today) return todayStr;
  const weekdayMonZero = (today.getUTCDay() + 6) % 7;
  return formatDate(addDays(today, -weekdayMonZero));
}

// Progress for one publicly rendered goal. Only enabled, non-snoozed goals are
// eligible — a goal the owner disabled or snoozed is never exposed on a public
// badge, even when addressed by id. Returns null when no eligible goal exists
// (the route answers 404). Actuals read pre-aggregated summaries only, matching
// the authenticated goals chart (no current-day heartbeat overlay).
export async function getGoalProgressData(
  db: D1Database,
  userId: string,
  tz: string,
  goalId?: string,
): Promise<GoalProgressData | null> {
  const columns = "id, title, type, delta, target_seconds, languages, editors, projects";
  const goal = goalId
    ? await db
        .prepare(`SELECT ${columns} FROM goals WHERE id = ? AND user_id = ? AND is_enabled = 1 AND is_snoozed = 0`)
        .bind(goalId, userId)
        .first<GoalRow>()
    : await db
        .prepare(
          `SELECT ${columns} FROM goals WHERE user_id = ? AND is_enabled = 1 AND is_snoozed = 0
           ORDER BY created_at ASC, id ASC LIMIT 1`,
        )
        .bind(userId)
        .first<GoalRow>();
  if (!goal) return null;

  const todayStr = formatDate(getToday(tz));
  const startStr = goalPeriodStartDate(todayStr, goal.delta);

  const filterColumn = goal.type === "languages"
    ? "language"
    : goal.type === "editors"
      ? "editor"
      : goal.type === "projects"
        ? "project"
        : null;
  const filterValues = filterColumn ? parseGoalFilterList(goal, filterColumn) : [];

  let sql = "SELECT COALESCE(SUM(total_seconds), 0) AS seconds FROM summaries WHERE user_id = ? AND date >= ? AND date <= ?";
  const binds: unknown[] = [userId, startStr, todayStr];
  if (filterColumn && filterValues.length > 0) {
    sql += ` AND ${filterColumn} IN (${filterValues.map(() => "?").join(", ")})`;
    binds.push(...filterValues);
  }
  const row = await db.prepare(sql).bind(...binds).first<{ seconds: number | null }>();

  const actualSeconds = Number(row?.seconds ?? 0);
  const targetSeconds = Number(goal.target_seconds);
  const percent = targetSeconds > 0 ? (actualSeconds / targetSeconds) * 100 : 0;
  return { title: goal.title, percent, actualSeconds, targetSeconds, delta: goal.delta };
}

export async function getGoalProgressBadgeData(
  db: D1Database,
  userId: string,
  tz: string,
  goalId?: string,
): Promise<BadgeData | null> {
  const progress = await getGoalProgressData(db, userId, tz, goalId);
  if (!progress) return null;
  return { label: "goal", value: formatBadgePercent(progress.percent) };
}

export type ProfileMetricKey =
  | "today"
  | "week"
  | "all_time"
  | "top_language"
  | "current_streak"
  | "goal_progress";

export const PROFILE_METRIC_KEYS: readonly ProfileMetricKey[] = [
  "today",
  "week",
  "all_time",
  "top_language",
  "current_streak",
  "goal_progress",
];

// Default composite card sections (FR-010): personal metrics only.
export const DEFAULT_PROFILE_METRICS: readonly ProfileMetricKey[] = [
  "today",
  "week",
  "top_language",
  "current_streak",
];

// Trailing window shared by the `week` and `top_language` profile sections.
// The profile card intentionally has no `range` selector, so top_language uses
// this fixed default (mirrors the top_language badge default).
const PROFILE_LANGUAGE_DAYS = 7;

export interface ProfileMetricSection {
  key: ProfileMetricKey;
  label: string;
  value: string;
}

/**
 * Build the composite profile card sections in requested order, running only
 * the bounded reads the requested metrics need. Returns null when
 * `goal_progress` is requested but the user has no eligible goal (the route
 * answers 404 per the spec's privacy rules).
 */
export async function getProfileCardData(
  db: D1Database,
  userId: string,
  tz: string,
  timeoutMinutes: number,
  metrics: readonly ProfileMetricKey[],
): Promise<ProfileMetricSection[] | null> {
  const requested = new Set(metrics);
  const today = getToday(tz);
  const todayStr = formatDate(today);

  const needToday = requested.has("today") || requested.has("week") ||
    requested.has("all_time") || requested.has("current_streak");
  const todaySeconds = needToday
    ? await computeTodaySeconds(db, userId, tz, todayStr, timeoutMinutes)
    : 0;

  // One summaries scan covers both week and streak needs: the streak window is
  // a superset of the trailing week.
  const windowDays = requested.has("current_streak") ? STREAK_DAYS : PROFILE_LANGUAGE_DAYS;
  const needWindow = requested.has("week") || requested.has("current_streak");
  const dayTotals = needWindow
    ? (await loadSummaryDayTotals(db, userId, formatDate(addDays(today, -(windowDays - 1))), todayStr)).dayTotals
    : new Map<string, number>();
  if (needWindow && todaySeconds > 0) dayTotals.set(todayStr, todaySeconds);

  const values = new Map<ProfileMetricKey, string>();

  if (requested.has("today")) {
    values.set("today", formatHumanReadable(todaySeconds));
  }
  if (requested.has("week")) {
    const weekStart = formatDate(addDays(today, -(PROFILE_LANGUAGE_DAYS - 1)));
    let weekSeconds = 0;
    for (const [date, seconds] of dayTotals) {
      if (date >= weekStart && date <= todayStr) weekSeconds += seconds;
    }
    values.set("week", formatHumanReadable(weekSeconds));
  }
  if (requested.has("all_time")) {
    const allTime = await loadAllTimeSeconds(db, userId, todayStr);
    values.set("all_time", formatHumanReadable(allTime + todaySeconds));
  }
  if (requested.has("top_language")) {
    const startStr = formatDate(addDays(today, -(PROFILE_LANGUAGE_DAYS - 1)));
    const languages = await loadLanguageShares(db, userId, tz, todayStr, startStr, timeoutMinutes);
    const top = languages[0] ?? null;
    values.set("top_language", top ? `${top.language} / ${Math.round(top.percent)}%` : "No language");
  }
  if (requested.has("current_streak")) {
    const stats = calculateStreakStats(dayTotals, todayStr);
    values.set("current_streak", formatDays(stats.currentStreak));
  }
  if (requested.has("goal_progress")) {
    const progress = await getGoalProgressData(db, userId, tz);
    if (!progress) return null;
    const cadence = progress.delta === "week" ? "week" : "day";
    values.set(
      "goal_progress",
      `${formatBadgePercent(progress.percent)} of ${formatHumanReadable(progress.targetSeconds)} / ${cadence}`,
    );
  }

  return metrics.map((key) => ({
    key,
    label: PROFILE_METRIC_LABELS[key],
    value: values.get(key) ?? "",
  }));
}

export const PROFILE_METRIC_LABELS: Record<ProfileMetricKey, string> = {
  today: "Today",
  week: "Last 7 days",
  all_time: "All time",
  top_language: "Top language",
  current_streak: "Current streak",
  goal_progress: "Goal progress",
};

// Coding seconds over a badge range: bounded summaries reads for past days
// plus the current-day heartbeat overlay, matching existing card semantics.
async function loadRangeTotalSeconds(
  db: D1Database,
  userId: string,
  tz: string,
  timeoutMinutes: number,
  range: BadgeRange,
): Promise<number> {
  const today = getToday(tz);
  const todayStr = formatDate(today);
  const todaySeconds = await computeTodaySeconds(db, userId, tz, todayStr, timeoutMinutes);
  if (range.key === "today") return todaySeconds;
  if (range.days === null) {
    const past = await loadAllTimeSeconds(db, userId, todayStr);
    return past + todaySeconds;
  }
  const startStr = formatDate(addDays(today, -(range.days - 1)));
  const { totalSeconds } = await loadSummaryDayTotals(db, userId, startStr, todayStr);
  return totalSeconds + todaySeconds;
}

// All-time totals sum the pre-aggregated summaries in a single indexed
// aggregate (no raw history scan; see docs/cloudflare-constraints.md). Rows
// for the current local day are excluded so the heartbeat overlay the callers
// add is never double-counted.
async function loadAllTimeSeconds(db: D1Database, userId: string, todayStr: string): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(total_seconds), 0) AS seconds FROM summaries WHERE user_id = ? AND date < ?")
    .bind(userId, todayStr)
    .first<{ seconds: number | null }>();
  return Number(row?.seconds ?? 0);
}

function resolveBadgeWindow(tz: string, range: BadgeRange): { todayStr: string; startStr: string } {
  const today = getToday(tz);
  const todayStr = formatDate(today);
  if (range.days === null) return { todayStr, startStr: "0001-01-01" };
  return { todayStr, startStr: formatDate(addDays(today, -(range.days - 1))) };
}

function parseGoalFilterList(goal: GoalRow, filterColumn: string): string[] {
  const raw = filterColumn === "language" ? goal.languages : filterColumn === "editor" ? goal.editors : goal.projects;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
}

function formatBadgePercent(percent: number): string {
  const rounded = Math.round(Math.max(0, percent));
  return `${Math.min(999, rounded)}%`;
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

async function computeTodayLanguageSeconds(
  db: D1Database,
  userId: string,
  tz: string,
  todayStr: string,
  timeoutMinutes: number,
): Promise<Map<string, number>> {
  const { start, end } = getEpochBoundsForDate(todayStr, tz);
  const { results } = await db
    .prepare(
      "SELECT time, language FROM heartbeats WHERE user_id = ? AND time >= ? AND time < ? ORDER BY time ASC",
    )
    .bind(userId, start, end)
    .all<{ time: number; language: string | null }>();

  const timeout = timeoutMinutes * 60;
  const totals = new Map<string, number>();
  for (let i = 1; i < results.length; i++) {
    const prev = results[i - 1];
    const gap = results[i].time - prev.time;
    if (gap <= 0 || gap > timeout) continue;
    const language = prev.language && prev.language.length > 0 ? prev.language : UNKNOWN_LANGUAGE;
    totals.set(language, (totals.get(language) ?? 0) + gap);
  }
  return totals;
}
