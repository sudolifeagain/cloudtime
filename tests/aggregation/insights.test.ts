/**
 * Unit tests for src/utils/insights.ts - the pure insight builder
 * (specs/103-insights/). No D1, no KV.
 */
import { describe, expect, it } from "vitest";
import { buildInsight, type ResolvedRange } from "../../src/utils/insights";
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
});
