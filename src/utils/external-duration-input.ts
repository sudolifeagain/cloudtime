/**
 * Validation for the external-duration request bodies (specs/106-external-durations/).
 *
 * Pure: turns an untrusted parsed JSON value into a normalised row ready to
 * upsert, or a 400-worthy error. No D1, no I/O.
 */
import type { components } from "../types/generated";

export type ExternalDurationType = "file" | "app" | "domain";
type Category = components["schemas"]["Category"];

const TYPES = new Set<string>(["file", "app", "domain"]);
const VALID_CATEGORIES = new Set<string>([
  "coding",
  "building",
  "indexing",
  "debugging",
  "browsing",
  "running tests",
  "writing tests",
  "manual testing",
  "writing docs",
  "communicating",
  "code reviewing",
  "notes",
  "researching",
  "learning",
  "designing",
  "ai coding",
  "advising",
  "meeting",
  "planning",
  "supporting",
  "translating",
]);

export interface ValidatedExternalDuration {
  external_id: string;
  entity: string;
  type: ExternalDurationType;
  start_time: number;
  end_time: number;
  category: Category | null;
  project: string | null;
  branch: string | null;
  language: string | null;
  meta: string | null;
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

export function validateExternalDuration(body: unknown): ValidationResult<ValidatedExternalDuration> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail("Request body must be a JSON object");
  }
  const r = body as Record<string, unknown>;

  if (typeof r.external_id !== "string" || r.external_id.length === 0) {
    return fail("external_id is required and must be a non-empty string");
  }
  if (typeof r.entity !== "string" || r.entity.length === 0) {
    return fail("entity is required and must be a non-empty string");
  }
  if (!TYPES.has(r.type as string)) {
    return fail("type must be one of file, app, domain");
  }
  if (typeof r.start_time !== "number" || !Number.isFinite(r.start_time)) {
    return fail("start_time must be a number");
  }
  if (typeof r.end_time !== "number" || !Number.isFinite(r.end_time)) {
    return fail("end_time must be a number");
  }
  if (r.end_time < r.start_time) {
    return fail("end_time must be greater than or equal to start_time");
  }
  if (r.category !== undefined && r.category !== null) {
    if (typeof r.category !== "string") {
      return fail("category must be a string");
    }
    if (!VALID_CATEGORIES.has(r.category)) {
      return fail(`category must be one of: ${[...VALID_CATEGORIES].join(", ")}`);
    }
  }
  for (const field of ["project", "branch", "language", "meta"] as const) {
    if (r[field] !== undefined && r[field] !== null && typeof r[field] !== "string") {
      return fail(`${field} must be a string`);
    }
  }

  return {
    ok: true,
    value: {
      external_id: r.external_id,
      entity: r.entity,
      type: r.type as ExternalDurationType,
      start_time: r.start_time,
      end_time: r.end_time,
      category: (r.category ?? null) as Category | null,
      project: optionalString(r.project),
      branch: optionalString(r.branch),
      language: optionalString(r.language),
      meta: optionalString(r.meta),
    },
  };
}
