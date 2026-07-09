/**
 * Shared RFC 3339 date-time validation + normalisation helpers.
 *
 * Extracted from commit ingestion so other request validators (AI price rows,
 * Issue #200) reuse one implementation instead of duplicating the parser. Pure:
 * no D1, no I/O.
 */
import { toSqliteDateTime } from "./user";

const RFC3339_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * True when `v` is a syntactically valid RFC 3339 date-time with a real
 * calendar date (rejects e.g. `2026-02-31T00:00:00Z`).
 */
export function isValidDateTime(v: string): boolean {
  const m = RFC3339_DATE_TIME.exec(v);
  if (!m) return false;

  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw] = m;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    Number.isFinite(Date.parse(v))
  );
}

/**
 * Validate an optional date-time field. Returns the value normalised to the
 * SQLite datetime format (UTC, no millis) or null when absent; `ok: false`
 * when present but unparseable.
 */
export function normalizeOptionalDate(
  v: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false };
  if (!isValidDateTime(v)) return { ok: false };
  const ms = Date.parse(v);
  return { ok: true, value: toSqliteDateTime(new Date(ms)) };
}
