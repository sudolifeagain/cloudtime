/**
 * Pure insight builders (specs/103-insights/). Shape a window of `summaries`
 * rows into the `Insight` response for a given `insight_type`. No D1, no I/O -
 * the route owns the single grouped SELECT and passes the rows in.
 *
 * Dimension insights reuse `aggregateDimension` (grouping, percent, NULL ->
 * "Unknown", formatting). Temporal insights derive per-date totals.
 */
import type { components } from "../types/generated";
import { formatDigital, formatHumanReadable } from "./time-format";
import { aggregateDimension, type Dimension, type SummaryRow } from "./summary-builder";

type Insight = components["schemas"]["Insight"];
type SummaryItem = components["schemas"]["SummaryItem"];

export const INSIGHT_TYPES = [
  "weekday",
  "days",
  "best_day",
  "daily_average",
  "projects",
  "languages",
  "editors",
  "categories",
  "machines",
  "operating_systems",
] as const;
export type InsightType = (typeof INSIGHT_TYPES)[number];

/** insight_type -> the `summaries` column it groups by. */
const DIMENSION_INSIGHTS: Partial<Record<InsightType, Dimension>> = {
  projects: "project",
  languages: "language",
  editors: "editor",
  categories: "category",
  machines: "machine",
  operating_systems: "operating_system",
};

const WEEKDAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

export interface ResolvedRange {
  start: string;
  end: string;
  text: string;
}

/** Day-of-week (0=Sunday) for a local `YYYY-MM-DD` date string. */
function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function buildItem(name: string, totalSeconds: number, denom: number): SummaryItem {
  return {
    name,
    total_seconds: totalSeconds,
    percent: denom > 0 ? Math.round((totalSeconds / denom) * 10000) / 100 : 0,
    digital: formatDigital(totalSeconds),
    text: formatHumanReadable(totalSeconds),
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: Math.floor(totalSeconds % 60),
  };
}

/** Sum total_seconds per date. */
function dailyTotals(rows: SummaryRow[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const r of rows) {
    totals.set(r.date, (totals.get(r.date) ?? 0) + r.total_seconds);
  }
  return totals;
}

export function buildInsight(
  type: InsightType,
  rows: SummaryRow[],
  range: ResolvedRange,
  tz: string,
): Insight {
  const grandTotal = rows.reduce((sum, r) => sum + r.total_seconds, 0);
  const base: Insight = {
    type,
    range: {
      start: `${range.start}T00:00:00Z`,
      end: `${range.end}T23:59:59Z`,
      text: range.text,
      timezone: tz,
    },
  };

  const dimension = DIMENSION_INSIGHTS[type];
  if (dimension) {
    return { ...base, items: aggregateDimension(rows, dimension, grandTotal) };
  }

  const totals = dailyTotals(rows);

  switch (type) {
    case "days": {
      const days = Array.from(totals.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, total_seconds]) => ({
          date,
          total_seconds,
          text: formatHumanReadable(total_seconds),
        }));
      return { ...base, days };
    }

    case "best_day": {
      let best: { date: string; total_seconds: number } | null = null;
      // Ascending date scan + strict `>` makes ties resolve to the earliest day.
      for (const [date, total] of Array.from(totals.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
        if (best === null || total > best.total_seconds) {
          best = { date, total_seconds: total };
        }
      }
      return {
        ...base,
        best_day: best
          ? { date: best.date, total_seconds: best.total_seconds, text: formatHumanReadable(best.total_seconds) }
          : { total_seconds: 0, text: formatHumanReadable(0) },
      };
    }

    case "daily_average": {
      const activeDays = totals.size;
      const seconds = activeDays > 0 ? grandTotal / activeDays : 0;
      return { ...base, daily_average: { seconds, text: formatHumanReadable(Math.round(seconds)) } };
    }

    case "weekday": {
      const byWeekday = new Map<number, { sum: number; count: number }>();
      for (const [date, total] of totals) {
        const wd = weekdayOf(date);
        const acc = byWeekday.get(wd) ?? { sum: 0, count: 0 };
        acc.sum += total;
        acc.count += 1;
        byWeekday.set(wd, acc);
      }
      const averages = Array.from(byWeekday.entries()).map(([wd, { sum, count }]) => ({
        wd,
        avg: count > 0 ? sum / count : 0,
      }));
      const denom = averages.reduce((s, a) => s + a.avg, 0);
      const items = averages
        .sort((a, b) => b.avg - a.avg)
        .map(({ wd, avg }) => buildItem(WEEKDAY_NAMES[wd], avg, denom));
      return { ...base, items };
    }

    default:
      return base;
  }
}
