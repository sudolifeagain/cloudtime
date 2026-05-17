import { describe, expect, it } from "vitest";
import {
  aggregateDimension,
  buildSummary,
  type SummaryRow,
} from "../../src/utils/summary-builder";

function row(partial: Partial<SummaryRow>): SummaryRow {
  return {
    date: "2026-03-14",
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

describe("aggregateDimension", () => {
  it("sums total_seconds by dimension value", () => {
    const rows: SummaryRow[] = [
      row({ project: "cloudtime", total_seconds: 1200 }),
      row({ project: "cloudtime", total_seconds: 600 }),
      row({ project: "side-project", total_seconds: 300 }),
    ];

    const result = aggregateDimension(rows, "project", 2100);

    expect(result.map((r) => [r.name, r.total_seconds])).toEqual([
      ["cloudtime", 1800],
      ["side-project", 300],
    ]);
  });

  it("sorts items by total_seconds descending", () => {
    const rows: SummaryRow[] = [
      row({ language: "Go", total_seconds: 100 }),
      row({ language: "TypeScript", total_seconds: 500 }),
      row({ language: "Python", total_seconds: 300 }),
    ];

    const result = aggregateDimension(rows, "language", 900);

    expect(result.map((r) => r.name)).toEqual(["TypeScript", "Python", "Go"]);
  });

  it("collapses null/empty dimension values to 'Unknown'", () => {
    const rows: SummaryRow[] = [
      row({ project: null, total_seconds: 100 }),
      row({ project: "", total_seconds: 50 }),
      row({ project: "real", total_seconds: 200 }),
    ];

    const result = aggregateDimension(rows, "project", 350);

    expect(result.map((r) => [r.name, r.total_seconds])).toEqual([
      ["real", 200],
      ["Unknown", 150],
    ]);
  });

  it("computes percent against the grand total, rounded to 2 decimals", () => {
    const rows: SummaryRow[] = [
      row({ language: "TypeScript", total_seconds: 1500 }),
      row({ language: "Go", total_seconds: 500 }),
    ];

    const result = aggregateDimension(rows, "language", 2000);

    expect(result[0].percent).toBe(75);
    expect(result[1].percent).toBe(25);
  });

  it("returns percent=0 when grand total is zero", () => {
    const result = aggregateDimension(
      [row({ language: "TypeScript", total_seconds: 0 })],
      "language",
      0,
    );
    expect(result[0].percent).toBe(0);
  });
});

describe("buildSummary", () => {
  it("returns grand_total derived from summing rows", () => {
    const rows: SummaryRow[] = [
      row({ project: "p", total_seconds: 1800 }),
      row({ project: "p", total_seconds: 1800 }),
    ];

    const summary = buildSummary("2026-03-14", rows, "Asia/Tokyo");

    expect(summary.grand_total.total_seconds).toBe(3600);
    expect(summary.grand_total.digital).toBe("1:00");
    expect(summary.grand_total.text).toBe("1 hr");
    expect(summary.grand_total.hours).toBe(1);
    expect(summary.grand_total.minutes).toBe(0);
  });

  it("populates all seven dimension keys", () => {
    const summary = buildSummary("2026-03-14", [
      row({
        project: "cloudtime",
        language: "TypeScript",
        editor: "VSCode",
        operating_system: "macOS",
        category: "coding",
        branch: "main",
        machine: "laptop",
        total_seconds: 600,
      }),
    ]);

    expect(summary.projects?.[0].name).toBe("cloudtime");
    expect(summary.languages?.[0].name).toBe("TypeScript");
    expect(summary.editors?.[0].name).toBe("VSCode");
    expect(summary.operating_systems?.[0].name).toBe("macOS");
    expect(summary.categories?.[0].name).toBe("coding");
    expect(summary.branches?.[0].name).toBe("main");
    expect(summary.machines?.[0].name).toBe("laptop");
  });

  it("records the timezone in range.timezone (defaulting to UTC when unset)", () => {
    const tokyo = buildSummary("2026-03-14", [], "Asia/Tokyo");
    expect(tokyo.range.timezone).toBe("Asia/Tokyo");

    const utc = buildSummary("2026-03-14", []);
    expect(utc.range.timezone).toBe("UTC");
  });

  it("returns zero grand_total for empty rows", () => {
    const summary = buildSummary("2026-03-14", []);
    expect(summary.grand_total.total_seconds).toBe(0);
    expect(summary.grand_total.digital).toBe("0:00");
    expect(summary.grand_total.text).toBe("0 secs");
  });
});
