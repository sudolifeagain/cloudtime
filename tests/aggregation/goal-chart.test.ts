import { describe, expect, it } from "vitest";
import {
  buildChart,
  buildDayRanges,
  buildWeekRanges,
  classifyRange,
  rebucketWeekly,
  topStatus,
  type ChartEntry,
  type ChartRange,
} from "../../src/utils/goal-chart";

const FRI_2026_05_15_NOON_JST = Date.UTC(2026, 4, 15, 3, 0, 0); // 12:00 JST
const SUN_2026_03_08_NOON_NY = Date.UTC(2026, 2, 8, 16, 0, 0);  // 12:00 EDT (DST spring-forward day)

describe("buildDayRanges", () => {
  it("returns 7 consecutive local-tz dates oldest first, ending today", () => {
    const ranges = buildDayRanges(FRI_2026_05_15_NOON_JST, "Asia/Tokyo");

    expect(ranges).toHaveLength(7);
    expect(ranges.map((r) => r.date)).toEqual([
      "2026-05-09",
      "2026-05-10",
      "2026-05-11",
      "2026-05-12",
      "2026-05-13",
      "2026-05-14",
      "2026-05-15",
    ]);
    for (const r of ranges) expect(r.timezone).toBe("Asia/Tokyo");
  });

  it("walks the local timezone (not UTC) at the day boundary", () => {
    // 2026-05-15 23:30 UTC == 2026-05-16 08:30 JST.
    const nearMidnightUtc = Date.UTC(2026, 4, 15, 23, 30, 0);
    const ranges = buildDayRanges(nearMidnightUtc, "Asia/Tokyo");
    expect(ranges[ranges.length - 1].date).toBe("2026-05-16");
  });

  it("emits start/end that correctly span a 23-hour DST spring-forward day", () => {
    // The most recent range covers 2026-03-08 in America/New_York (spring forward).
    const ranges = buildDayRanges(SUN_2026_03_08_NOON_NY, "America/New_York");
    const current = ranges[ranges.length - 1];
    const startMs = Date.parse(current.start);
    const endMs = Date.parse(current.end);
    expect(current.date).toBe("2026-03-08");
    expect((endMs - startMs) / 3_600_000).toBeCloseTo(23, 5);
  });

  it("does not skip the spring-forward day just after local midnight", () => {
    // 2026-03-09 04:30 UTC == 2026-03-09 00:30 America/New_York.
    const justAfterSpringForwardMidnight = Date.UTC(2026, 2, 9, 4, 30, 0);
    const ranges = buildDayRanges(justAfterSpringForwardMidnight, "America/New_York");

    expect(ranges.map((r) => r.date)).toEqual([
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
    ]);
  });
});

describe("buildWeekRanges (ISO Mon-Sun)", () => {
  it("returns 7 weeks oldest first, dated by Monday", () => {
    // 2026-05-15 is a Friday; its ISO Monday is 2026-05-11.
    const ranges = buildWeekRanges(FRI_2026_05_15_NOON_JST, "Asia/Tokyo");
    expect(ranges).toHaveLength(7);
    expect(ranges.map((r) => r.date)).toEqual([
      "2026-03-30",
      "2026-04-06",
      "2026-04-13",
      "2026-04-20",
      "2026-04-27",
      "2026-05-04",
      "2026-05-11",
    ]);
  });

  it("anchors when the current local date is itself a Monday", () => {
    // 2026-05-11 noon JST.
    const mondayNoonJst = Date.UTC(2026, 4, 11, 3, 0, 0);
    const ranges = buildWeekRanges(mondayNoonJst, "Asia/Tokyo");
    expect(ranges[ranges.length - 1].date).toBe("2026-05-11");
  });

  it("anchors when the current local date is a Sunday", () => {
    // 2026-05-17 noon JST is the Sunday closing 2026-05-11..05-17.
    const sundayNoonJst = Date.UTC(2026, 4, 17, 3, 0, 0);
    const ranges = buildWeekRanges(sundayNoonJst, "Asia/Tokyo");
    expect(ranges[ranges.length - 1].date).toBe("2026-05-11");
  });
});

describe("classifyRange", () => {
  it("returns 'pending' for the current period regardless of comparisons", () => {
    expect(classifyRange(0, 3600, false, true)).toBe("pending");
    expect(classifyRange(10_000, 3600, false, true)).toBe("pending");
    expect(classifyRange(10_000, 3600, true, true)).toBe("pending");
  });

  it("treats equality at target as success (both normal and inverse goals)", () => {
    expect(classifyRange(3600, 3600, false, false)).toBe("success");
    expect(classifyRange(3600, 3600, true, false)).toBe("success");
  });

  it("normal goal: success when actual >= target, fail otherwise", () => {
    expect(classifyRange(3601, 3600, false, false)).toBe("success");
    expect(classifyRange(3599, 3600, false, false)).toBe("fail");
  });

  it("inverse goal: success when actual <= target, fail otherwise", () => {
    expect(classifyRange(1799, 1800, true, false)).toBe("success");
    expect(classifyRange(1801, 1800, true, false)).toBe("fail");
  });
});

describe("topStatus", () => {
  const mkEntry = (status: "success" | "fail" | "pending"): ChartEntry => ({
    actual_seconds: 0,
    goal_seconds: 0,
    range: { date: "x", start: "x", end: "x", text: "x", timezone: "UTC" },
    range_status: status,
  });

  it("returns 'pending' when the goal is snoozed regardless of period outcomes", () => {
    const chart = [mkEntry("success"), mkEntry("success"), mkEntry("pending")];
    expect(topStatus(chart, true)).toBe("pending");
  });

  it("returns the most recently completed period's status (second-to-last)", () => {
    expect(
      topStatus([mkEntry("fail"), mkEntry("success"), mkEntry("pending")], false),
    ).toBe("success");
    expect(
      topStatus([mkEntry("success"), mkEntry("fail"), mkEntry("pending")], false),
    ).toBe("fail");
  });

  it("returns 'pending' when the chart has fewer than 2 entries", () => {
    expect(topStatus([], false)).toBe("pending");
    expect(topStatus([mkEntry("pending")], false)).toBe("pending");
  });
});

describe("buildChart", () => {
  function mkRange(date: string): ChartRange {
    return { date, start: "x", end: "x", text: date, timezone: "UTC" };
  }

  it("zeros out missing periods and marks only the last as pending", () => {
    const ranges = ["d1", "d2", "d3", "d4", "d5", "d6", "d7"].map(mkRange);
    const actuals = new Map([
      ["d2", 1800],
      ["d6", 5400],
    ]);
    const chart = buildChart(ranges, actuals, 3600, false);

    expect(chart.map((c) => c.actual_seconds)).toEqual([0, 1800, 0, 0, 0, 5400, 0]);
    expect(chart.map((c) => c.range_status)).toEqual([
      "fail",
      "fail", // 1800 < 3600
      "fail",
      "fail",
      "fail",
      "success", // 5400 >= 3600
      "pending",
    ]);
    for (const entry of chart) expect(entry.goal_seconds).toBe(3600);
  });

  it("inverse goal: under-cap days succeed", () => {
    const ranges = ["d1", "d2", "d3", "d4", "d5", "d6", "d7"].map(mkRange);
    const actuals = new Map([
      ["d1", 600],
      ["d2", 1800],
      ["d3", 1801],
    ]);
    const chart = buildChart(ranges, actuals, 1800, true);
    expect(chart[0].range_status).toBe("success");
    expect(chart[1].range_status).toBe("success");
    expect(chart[2].range_status).toBe("fail");
    expect(chart[chart.length - 1].range_status).toBe("pending");
  });
});

describe("rebucketWeekly", () => {
  it("sums daily totals into the Monday-keyed bucket of each containing week", () => {
    // Week ranges defined by their Mondays.
    const weekRanges: ChartRange[] = [
      { date: "2026-05-04", start: "x", end: "x", text: "x", timezone: "UTC" },
      { date: "2026-05-11", start: "x", end: "x", text: "x", timezone: "UTC" },
    ];

    const daily = new Map([
      ["2026-05-04", 1000], // Monday
      ["2026-05-07", 200],  // Thursday
      ["2026-05-10", 300],  // Sunday
      ["2026-05-11", 400],  // Monday (next week)
      ["2026-05-12", 50],   // Tuesday (next week)
    ]);

    const weekly = rebucketWeekly(daily, weekRanges);
    expect(weekly.get("2026-05-04")).toBe(1500);
    expect(weekly.get("2026-05-11")).toBe(450);
  });

  it("drops daily totals outside the listed weeks", () => {
    const weekRanges: ChartRange[] = [
      { date: "2026-05-11", start: "x", end: "x", text: "x", timezone: "UTC" },
    ];
    const daily = new Map([
      ["2026-05-04", 1000], // outside the window
      ["2026-05-11", 400],
    ]);
    const weekly = rebucketWeekly(daily, weekRanges);
    expect(weekly.get("2026-05-04")).toBeUndefined();
    expect(weekly.get("2026-05-11")).toBe(400);
  });
});
