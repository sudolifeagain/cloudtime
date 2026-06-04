/**
 * Unit tests for src/utils/insights.ts - the pure insight builder
 * (specs/103-insights/). No D1, no KV.
 */
import { describe, expect, it } from "vitest";
import {
  buildHoursInsight,
  buildInsight,
  parseWeekday,
  type HourlyRow,
  type ResolvedRange,
} from "../../src/utils/insights";
import type { SummaryRow } from "../../src/utils/summary-builder";

const RANGE: ResolvedRange = { start: "2026-05-01", end: "2026-05-31", text: "last 30 days" };

function row(partial: Partial<SummaryRow>): SummaryRow {
  return {
    date: "2026-05-01",
    project: null,
    language: null,
    editor: null,
    operating_system: null,
    category: null,
    branch: null,
    machine: null,
    total_seconds: 0,
    ...partial,
  };
}

describe("buildInsight - dimension types", () => {
  const rows: SummaryRow[] = [
    row({ date: "2026-05-01", language: "TypeScript", total_seconds: 7200 }),
    row({ date: "2026-05-02", language: "Go", total_seconds: 3600 }),
    row({ date: "2026-05-03", language: "TypeScript", total_seconds: 1800 }),
    row({ date: "2026-05-03", language: null, total_seconds: 600 }),
  ];

  it("groups languages, orders desc, computes percent of total, buckets NULL as Unknown", () => {
    const out = buildInsight("languages", rows, RANGE, "UTC");
    expect(out.type).toBe("languages");
    expect(out.range?.timezone).toBe("UTC");
    expect(out.range?.start).toBe("2026-05-01T00:00:00Z");
    expect(out.range?.end).toBe("2026-05-31T23:59:59Z");
    const items = out.items ?? [];
    expect(items.map((i) => i.name)).toEqual(["TypeScript", "Go", "Unknown"]);
    expect(items[0].total_seconds).toBe(9000); // 7200 + 1800
    // total = 13200; TS share = 9000/13200 = 68.18%
    expect(items[0].percent).toBeCloseTo(68.18, 1);
    expect(items.find((i) => i.name === "Unknown")?.total_seconds).toBe(600);
  });

  it("returns empty items for no rows", () => {
    const out = buildInsight("editors", [], RANGE, "UTC");
    expect(out.items).toEqual([]);
  });
});

describe("buildInsight - temporal types", () => {
  // Three active days: Mon 2026-05-04, Tue 2026-05-05, Mon 2026-05-11
  const rows: SummaryRow[] = [
    row({ date: "2026-05-04", total_seconds: 3600 }), // Monday
    row({ date: "2026-05-05", total_seconds: 1800 }), // Tuesday
    row({ date: "2026-05-11", total_seconds: 5400 }), // Monday
  ];

  it("days: active dates ascending with totals", () => {
    const out = buildInsight("days", rows, RANGE, "UTC");
    expect(out.days?.map((d) => d.date)).toEqual(["2026-05-04", "2026-05-05", "2026-05-11"]);
    expect(out.days?.[2].total_seconds).toBe(5400);
  });

  it("best_day: highest-total date", () => {
    const out = buildInsight("best_day", rows, RANGE, "UTC");
    expect(out.best_day?.date).toBe("2026-05-11");
    expect(out.best_day?.total_seconds).toBe(5400);
  });

  it("best_day: ties resolve to the earliest date", () => {
    const tied: SummaryRow[] = [
      row({ date: "2026-05-20", total_seconds: 1000 }),
      row({ date: "2026-05-10", total_seconds: 1000 }),
    ];
    expect(buildInsight("best_day", tied, RANGE, "UTC").best_day?.date).toBe("2026-05-10");
  });

  it("daily_average: total divided by active days", () => {
    const out = buildInsight("daily_average", rows, RANGE, "UTC");
    // (3600 + 1800 + 5400) / 3 = 3600
    expect(out.daily_average?.seconds).toBe(3600);
  });

  it("weekday: mean per active weekday occurrence, ordered desc", () => {
    const out = buildInsight("weekday", rows, RANGE, "UTC");
    const items = out.items ?? [];
    // Monday avg = (3600 + 5400) / 2 = 4500; Tuesday avg = 1800
    expect(items.map((i) => i.name)).toEqual(["Monday", "Tuesday"]);
    expect(items[0].total_seconds).toBe(4500);
    expect(items[1].total_seconds).toBe(1800);
  });

  it("zeroes best_day and daily_average when there is no activity", () => {
    expect(buildInsight("best_day", [], RANGE, "UTC").best_day?.total_seconds).toBe(0);
    expect(buildInsight("daily_average", [], RANGE, "UTC").daily_average?.seconds).toBe(0);
    expect(buildInsight("weekday", [], RANGE, "UTC").items).toEqual([]);
  });

  it("days: weekday filter keeps only matching dates, preserving order/shape", () => {
    // Monday filter (1) -> the two Mondays only.
    const mon = buildInsight("days", rows, RANGE, "UTC", 1);
    expect(mon.days?.map((d) => d.date)).toEqual(["2026-05-04", "2026-05-11"]);
    expect(mon.days?.[1].total_seconds).toBe(5400);
    // Tuesday filter (2) -> the single Tuesday.
    expect(buildInsight("days", rows, RANGE, "UTC", 2).days?.map((d) => d.date)).toEqual(["2026-05-05"]);
    // Sunday filter (0) -> no matches.
    expect(buildInsight("days", rows, RANGE, "UTC", 0).days).toEqual([]);
    // null filter -> unchanged (all active days).
    expect(buildInsight("days", rows, RANGE, "UTC", null).days?.map((d) => d.date)).toEqual([
      "2026-05-04",
      "2026-05-05",
      "2026-05-11",
    ]);
  });

  it("weekday filter only affects the `days` type", () => {
    // A non-null filter passed to a non-`days` type is ignored.
    const wd = buildInsight("weekday", rows, RANGE, "UTC", 1);
    expect(wd.items?.map((i) => i.name)).toEqual(["Monday", "Tuesday"]);
  });
});

describe("buildHoursInsight", () => {
  // Two active days; hour 9 split across both, hours 10 and 14 on one day each.
  const rows: HourlyRow[] = [
    { date: "2026-05-01", hour: 9, total_seconds: 3600 },
    { date: "2026-05-01", hour: 10, total_seconds: 1800 },
    { date: "2026-05-02", hour: 9, total_seconds: 1800 },
    { date: "2026-05-02", hour: 14, total_seconds: 600 },
  ];

  it("returns 24 buckets, ascending by hour, with the envelope populated", () => {
    const out = buildHoursInsight(rows, RANGE, "UTC");
    expect(out.type).toBe("hours");
    expect(out.range?.timezone).toBe("UTC");
    expect(out.hours).toHaveLength(24);
    expect(out.hours?.map((h) => h.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  it("each bucket is the hour's total divided by distinct active days", () => {
    const out = buildHoursInsight(rows, RANGE, "UTC");
    const byHour = new Map(out.hours?.map((h) => [h.hour, h.total_seconds]));
    // activeDays = 2
    expect(byHour.get(9)).toBe(2700); // (3600 + 1800) / 2
    expect(byHour.get(10)).toBe(900); // 1800 / 2
    expect(byHour.get(14)).toBe(300); // 600 / 2
    expect(byHour.get(0)).toBe(0);
    expect(byHour.get(23)).toBe(0);
  });

  it("the 24 buckets sum to the daily_average for the same range", () => {
    const hoursTotal = (buildHoursInsight(rows, RANGE, "UTC").hours ?? []).reduce(
      (sum, h) => sum + (h.total_seconds ?? 0),
      0,
    );
    // Same activity as daily summary rows: 2026-05-01 = 5400, 2026-05-02 = 2400.
    const summaryRows: SummaryRow[] = [
      row({ date: "2026-05-01", total_seconds: 5400 }),
      row({ date: "2026-05-02", total_seconds: 2400 }),
    ];
    const avg = buildInsight("daily_average", summaryRows, RANGE, "UTC").daily_average?.seconds;
    expect(hoursTotal).toBe(avg);
    expect(hoursTotal).toBe(3900);
  });

  it("returns 24 zero buckets when there is no activity", () => {
    const out = buildHoursInsight([], RANGE, "UTC");
    expect(out.hours).toHaveLength(24);
    expect(out.hours?.every((h) => h.total_seconds === 0)).toBe(true);
  });
});

describe("parseWeekday", () => {
  it("parses integers 0-6", () => {
    expect(parseWeekday("0")).toBe(0);
    expect(parseWeekday("6")).toBe(6);
  });

  it("parses case-insensitive weekday names, trimming whitespace", () => {
    expect(parseWeekday("sunday")).toBe(0);
    expect(parseWeekday("MONDAY")).toBe(1);
    expect(parseWeekday("  saturday  ")).toBe(6);
  });

  it("returns null for out-of-range, unknown, or empty input", () => {
    expect(parseWeekday("7")).toBeNull();
    expect(parseWeekday("-1")).toBeNull();
    expect(parseWeekday("funday")).toBeNull();
    expect(parseWeekday("")).toBeNull();
    expect(parseWeekday("01")).toBeNull();
  });
});
