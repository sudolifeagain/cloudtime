import type { components } from "../types/generated";
import { formatDigital, formatHumanReadable } from "./time-format";

type Summary = components["schemas"]["Summary"];
type SummaryItem = components["schemas"]["SummaryItem"];
type GrandTotal = components["schemas"]["GrandTotal"];

export type SummaryRow = {
  date: string;
  project: string | null;
  language: string | null;
  editor: string | null;
  operating_system: string | null;
  category: string | null;
  branch: string | null;
  machine: string | null;
  total_seconds: number;
};

export const DIMENSIONS = ["project", "language", "editor", "operating_system", "category", "branch", "machine"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const DIMENSION_TO_KEY: Record<Dimension, string> = {
  project: "projects",
  language: "languages",
  editor: "editors",
  operating_system: "operating_systems",
  category: "categories",
  branch: "branches",
  machine: "machines",
};

export function buildSummary(date: string, rows: SummaryRow[]): Summary {
  let grandTotalSeconds = 0;
  for (const row of rows) {
    grandTotalSeconds += row.total_seconds;
  }

  const grand_total: GrandTotal = {
    total_seconds: grandTotalSeconds,
    digital: formatDigital(grandTotalSeconds),
    text: formatHumanReadable(grandTotalSeconds),
    hours: Math.floor(grandTotalSeconds / 3600),
    minutes: Math.floor((grandTotalSeconds % 3600) / 60),
  };

  const dimensionItems: Record<string, SummaryItem[]> = {};
  for (const dim of DIMENSIONS) {
    dimensionItems[DIMENSION_TO_KEY[dim]] = aggregateDimension(rows, dim, grandTotalSeconds);
  }

  return {
    grand_total,
    range: {
      date,
      start: `${date}T00:00:00Z`,
      end: `${date}T23:59:59Z`,
      text: date,
      timezone: "UTC",
    },
    ...dimensionItems,
    entities: [],
    dependencies: [],
  };
}

export function aggregateDimension(rows: SummaryRow[], dimension: Dimension, grandTotal: number): SummaryItem[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const name = row[dimension] || "Unknown";
    totals.set(name, (totals.get(name) ?? 0) + row.total_seconds);
  }

  return Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, total_seconds]): SummaryItem => ({
      name,
      total_seconds,
      percent: grandTotal > 0 ? Math.round((total_seconds / grandTotal) * 10000) / 100 : 0,
      digital: formatDigital(total_seconds),
      text: formatHumanReadable(total_seconds),
      hours: Math.floor(total_seconds / 3600),
      minutes: Math.floor((total_seconds % 3600) / 60),
      seconds: Math.floor(total_seconds % 60),
    }));
}
