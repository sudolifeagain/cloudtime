import { describe, expect, it } from "vitest";
import {
  calculateStreakStats,
  goalPeriodStartDate,
  resolveBadgeRange,
  resolveCardRange,
} from "../../src/utils/cards/data";

describe("resolveBadgeRange", () => {
  it("falls back to the badge type's default when range is omitted", () => {
    expect(resolveBadgeRange(undefined, "today")?.key).toBe("today");
    expect(resolveBadgeRange(undefined, "last_7_days")?.key).toBe("last_7_days");
  });

  it("resolves every documented badge range", () => {
    for (const key of ["today", "last_7_days", "last_30_days", "last_6_months", "last_year", "all_time"]) {
      expect(resolveBadgeRange(key, "today")?.key).toBe(key);
    }
    expect(resolveBadgeRange("all_time", "today")?.days).toBeNull();
  });

  it("returns null for unsupported ranges instead of silently falling back", () => {
    expect(resolveBadgeRange("yesterday", "today")).toBeNull();
    expect(resolveBadgeRange("", "today")).toBeNull();
    expect(resolveBadgeRange("__proto__", "today")).toBeNull();
  });
});

describe("goalPeriodStartDate", () => {
  it("keeps day goals anchored to today", () => {
    expect(goalPeriodStartDate("2024-01-03", "day")).toBe("2024-01-03");
  });

  it("computes the ISO Monday for week goals", () => {
    // 2024-01-01 was a Monday.
    expect(goalPeriodStartDate("2024-01-01", "week")).toBe("2024-01-01");
    expect(goalPeriodStartDate("2024-01-03", "week")).toBe("2024-01-01");
    expect(goalPeriodStartDate("2024-01-07", "week")).toBe("2024-01-01");
    expect(goalPeriodStartDate("2024-01-08", "week")).toBe("2024-01-08");
  });
});

describe("calculateStreakStats", () => {
  it("calculates active days plus current and longest streaks", () => {
    const stats = calculateStreakStats(
      new Map([
        ["2026-06-14", 120],
        ["2026-06-15", 180],
        ["2026-06-17", 240],
        ["2026-06-18", 300],
      ]),
      "2026-06-18",
    );

    expect(stats).toEqual({
      trackedDays: 4,
      currentStreak: 2,
      longestStreak: 2,
    });
  });

  it("keeps the current streak alive when only yesterday has activity", () => {
    const stats = calculateStreakStats(
      new Map([
        ["2026-06-15", 120],
        ["2026-06-16", 180],
        ["2026-06-17", 240],
      ]),
      "2026-06-18",
    );

    expect(stats.currentStreak).toBe(3);
    expect(stats.longestStreak).toBe(3);
  });

  it("resets the current streak when both today and yesterday are inactive", () => {
    const stats = calculateStreakStats(
      new Map([
        ["2026-06-14", 120],
        ["2026-06-15", 180],
      ]),
      "2026-06-18",
    );

    expect(stats.currentStreak).toBe(0);
    expect(stats.longestStreak).toBe(2);
  });

  it("ignores zero-second days", () => {
    const stats = calculateStreakStats(
      new Map([
        ["2026-06-16", 120],
        ["2026-06-17", 0],
        ["2026-06-18", 180],
      ]),
      "2026-06-18",
    );

    expect(stats.trackedDays).toBe(2);
    expect(stats.currentStreak).toBe(1);
    expect(stats.longestStreak).toBe(1);
  });

  it("counts streaks only from the supplied range window", () => {
    const stats = calculateStreakStats(
      new Map([
        ["2026-06-17", 120],
        ["2026-06-18", 180],
      ]),
      "2026-06-18",
    );

    expect(stats).toEqual({
      trackedDays: 2,
      currentStreak: 2,
      longestStreak: 2,
    });
  });
});

describe("resolveCardRange", () => {
  it("normalizes supported card ranges", () => {
    expect(resolveCardRange("last_7_days")).toEqual({
      key: "last_7_days",
      days: 7,
      label: "the last 7 days",
    });
  });

  it("falls back to the default streak range for unsupported values", () => {
    expect(resolveCardRange("all_time").key).toBe("last_year");
    expect(resolveCardRange().key).toBe("last_year");
  });
});
