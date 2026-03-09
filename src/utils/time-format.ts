import type { components } from "../types/generated";

type SummaryRange = components["schemas"]["SummaryRange"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Format seconds as digital clock: "2:30" */
export function formatDigital(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}

/** Format seconds as human readable: "2 hrs 30 mins" */
export function formatHumanReadable(totalSeconds: number): string {
  if (totalSeconds === 0) return "0 secs";

  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);

  const parts: string[] = [];
  if (h > 0) parts.push(`${h} ${h === 1 ? "hr" : "hrs"}`);
  if (m > 0) parts.push(`${m} ${m === 1 ? "min" : "mins"}`);
  if (parts.length === 0 && s > 0) parts.push(`${s} ${s === 1 ? "sec" : "secs"}`);
  return parts.join(" ");
}

/** Validate and parse a YYYY-MM-DD date string. Returns null if invalid. */
function parseDate(date: string): Date | null {
  if (!DATE_RE.test(date)) return null;
  const [y, m, d] = date.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const parsed = new Date(ms);
  if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== m - 1 || parsed.getUTCDate() !== d) {
    return null;
  }
  return parsed;
}

/** Format a Date as YYYY-MM-DD in UTC */
function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Add days to a Date (returns new Date) */
function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86400000);
}

/**
 * Resolve a date range from either a predefined range name or start+end strings.
 * Returns null if the input is invalid.
 */
export function resolveDateRange(
  range?: string,
  start?: string,
  end?: string
): { start: string; end: string } | null {
  if (range) {
    return resolveNamedRange(range as SummaryRange);
  }

  if (start && end) {
    const s = parseDate(start);
    const e = parseDate(end);
    if (!s || !e) return null;
    if (s > e) return null;
    return { start, end };
  }

  return null;
}

function resolveNamedRange(range: SummaryRange): { start: string; end: string } | null {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayOfWeek = today.getUTCDay(); // 0=Sun

  switch (range) {
    case "Today":
      return { start: formatDate(today), end: formatDate(today) };

    case "Yesterday": {
      const y = addDays(today, -1);
      return { start: formatDate(y), end: formatDate(y) };
    }

    case "Last 7 Days":
      return { start: formatDate(addDays(today, -6)), end: formatDate(today) };

    case "Last 7 Days from Yesterday":
      return { start: formatDate(addDays(today, -7)), end: formatDate(addDays(today, -1)) };

    case "Last 14 Days":
      return { start: formatDate(addDays(today, -13)), end: formatDate(today) };

    case "Last 30 Days":
      return { start: formatDate(addDays(today, -29)), end: formatDate(today) };

    case "This Week": {
      // Monday-based week
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      return { start: formatDate(addDays(today, mondayOffset)), end: formatDate(today) };
    }

    case "Last Week": {
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const thisMonday = addDays(today, mondayOffset);
      const lastMonday = addDays(thisMonday, -7);
      const lastSunday = addDays(thisMonday, -1);
      return { start: formatDate(lastMonday), end: formatDate(lastSunday) };
    }

    case "This Month":
      return {
        start: formatDate(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))),
        end: formatDate(today),
      };

    case "Last Month": {
      const firstOfLastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
      const lastOfLastMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
      return { start: formatDate(firstOfLastMonth), end: formatDate(lastOfLastMonth) };
    }

    default:
      return null;
  }
}
