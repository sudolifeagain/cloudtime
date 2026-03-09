import type { components } from "../types/generated";

type SummaryRange = components["schemas"]["SummaryRange"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getDateFormatter(tz: string): Intl.DateTimeFormat {
  let fmt = dateFormatterCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatterCache.set(tz, fmt);
  }
  return fmt;
}

/**
 * Validate an IANA timezone string. Returns true if valid.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a Unix epoch (seconds) to a YYYY-MM-DD date string in the given timezone.
 * Falls back to UTC if tz is not provided or invalid.
 */
export function getDateForTimestamp(epochSeconds: number, tz?: string): string {
  const date = new Date(epochSeconds * 1000);
  if (!tz || tz === "UTC") {
    return date.toISOString().slice(0, 10);
  }
  try {
    const parts = getDateFormatter(tz).formatToParts(date);
    const y = parts.find((p) => p.type === "year")!.value;
    const m = parts.find((p) => p.type === "month")!.value;
    const d = parts.find((p) => p.type === "day")!.value;
    return `${y}-${m}-${d}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Get "today" as a Date anchored to midnight UTC, optionally shifted by IANA timezone.
 * When tz is provided, determines what date it is in that timezone, then returns
 * a UTC midnight Date for that date. Caller must validate tz before calling.
 */
export function getToday(tz?: string): Date {
  const today = getDateForTimestamp(Date.now() / 1000, tz);
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

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
export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Add days to a Date (returns new Date) */
export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86400000);
}

/**
 * Resolve a date range from either a predefined range name or start+end strings.
 * Returns null if the input is invalid.
 */
export function resolveDateRange(
  range?: string,
  start?: string,
  end?: string,
  tz?: string
): { start: string; end: string } | null {
  if (range) {
    return resolveNamedRange(range as SummaryRange, tz);
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

function resolveNamedRange(range: SummaryRange, tz?: string): { start: string; end: string } | null {
  const today = getToday(tz);
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
