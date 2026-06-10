/**
 * Validation for the commit ingestion request body (specs/135-commits-ingestion/).
 *
 * Pure: turns an untrusted parsed JSON value into a normalised row ready to
 * upsert, or a 400-worthy error. No D1, no I/O. `project` is taken from the
 * path by the route, not the body. Dates are normalised to the same SQLite
 * datetime format `created_at` uses, so the read path renders them schema-valid.
 */
import { INPUT_LIMITS, tooLong } from "./input-limits";
import { toSqliteDateTime } from "./user";

export interface ValidatedCommit {
  hash: string;
  message: string | null;
  author_name: string | null;
  author_email: string | null;
  author_date: string | null;
  committer_name: string | null;
  committer_email: string | null;
  committer_date: string | null;
  total_seconds: number | null;
  ref: string | null;
  url: string | null;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function optionalString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

const RFC3339_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isValidDateTime(v: string): boolean {
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
function normalizeOptionalDate(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false };
  if (!isValidDateTime(v)) return { ok: false };
  const ms = Date.parse(v);
  return { ok: true, value: toSqliteDateTime(new Date(ms)) };
}

export function validateCommitInput(body: unknown): ValidationResult<ValidatedCommit> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("Request body must be a JSON object");
  }
  const r = body as Record<string, unknown>;

  if (typeof r.hash !== "string" || r.hash.length === 0) {
    return fail("hash is required and must be a non-empty string");
  }
  if (tooLong(r.hash, INPUT_LIMITS.commitHash)) {
    return fail(`hash must be at most ${INPUT_LIMITS.commitHash} characters`);
  }

  if (r.total_seconds !== undefined && r.total_seconds !== null) {
    if (typeof r.total_seconds !== "number" || !Number.isFinite(r.total_seconds) || r.total_seconds < 0) {
      return fail("total_seconds must be a number >= 0");
    }
  }

  // Length caps mirror the OpenAPI maxLength constraints (Issue #158;
  // values from src/utils/input-limits.ts).
  const caps = {
    message: INPUT_LIMITS.commitMessage,
    author_name: INPUT_LIMITS.name,
    author_email: INPUT_LIMITS.email,
    committer_name: INPUT_LIMITS.name,
    committer_email: INPUT_LIMITS.email,
    ref: INPUT_LIMITS.name,
    url: INPUT_LIMITS.url,
  } as const;
  for (const field of ["message", "author_name", "author_email", "committer_name", "committer_email", "ref", "url"] as const) {
    const val = r[field];
    if (val === undefined || val === null) continue;
    if (typeof val !== "string") {
      return fail(`${field} must be a string`);
    }
    if (tooLong(val, caps[field])) {
      return fail(`${field} must be at most ${caps[field]} characters`);
    }
  }

  const authorDate = normalizeOptionalDate(r.author_date);
  if (!authorDate.ok) return fail("author_date must be a valid date-time");
  const committerDate = normalizeOptionalDate(r.committer_date);
  if (!committerDate.ok) return fail("committer_date must be a valid date-time");

  return {
    ok: true,
    value: {
      hash: r.hash,
      message: optionalString(r.message),
      author_name: optionalString(r.author_name),
      author_email: optionalString(r.author_email),
      author_date: authorDate.value,
      committer_name: optionalString(r.committer_name),
      committer_email: optionalString(r.committer_email),
      committer_date: committerDate.value,
      total_seconds: (r.total_seconds ?? null) as number | null,
      ref: optionalString(r.ref),
      url: optionalString(r.url),
    },
  };
}
