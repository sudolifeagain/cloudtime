import { describe, expect, it } from "vitest";
import { calculateStreakStats, resolveCardRange } from "../../src/utils/cards/data";

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
