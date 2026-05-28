/**
 * Validation for the Goals CRUD request bodies (specs/100-goals-crud/).
 *
 * Pure functions: they turn an untrusted parsed JSON value into either a
 * normalised, ready-to-persist object or a 400-worthy error message. No D1,
 * no I/O — unit-testable in isolation. Handlers translate the result into a
 * response.
 */

export type GoalType = "coding" | "languages" | "editors" | "projects";
export type GoalDelta = "day" | "week";

export const MAX_TITLE = 200;
export const MAX_TARGET_SECONDS = 604800; // one week in seconds

const GOAL_TYPES: readonly GoalType[] = ["coding", "languages", "editors", "projects"];
const GOAL_DELTAS: readonly GoalDelta[] = ["day", "week"];

/** Maps a filtered goal type to the array field that must be non-empty. */
const FILTER_FIELD: Record<GoalType, FilterField | null> = {
  coding: null,
  languages: "languages",
  editors: "editors",
  projects: "projects",
};

type FilterField = "languages" | "editors" | "projects";
const FILTER_FIELDS: readonly FilterField[] = ["languages", "editors", "projects"];

export interface ValidatedGoalCreate {
  title: string;
  type: GoalType;
  delta: GoalDelta;
  target_seconds: number;
  is_enabled: boolean;
  is_snoozed: boolean;
  is_inverse: boolean;
  languages: string[];
  editors: string[];
  projects: string[];
}

/** Only the fields a PATCH actually provided, normalised. */
export type ValidatedGoalUpdate = Partial<
  Pick<
    ValidatedGoalCreate,
    | "title"
    | "target_seconds"
    | "is_enabled"
    | "is_snoozed"
    | "is_inverse"
    | "languages"
    | "editors"
    | "projects"
  >
>;

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateTitle(raw: unknown): ValidationResult<string> {
  if (typeof raw !== "string") return fail("title is required and must be a string");
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fail("title must not be empty");
  if (trimmed.length > MAX_TITLE) return fail(`title must be at most ${MAX_TITLE} characters`);
  return { ok: true, value: trimmed };
}

function validateTargetSeconds(raw: unknown): ValidationResult<number> {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fail("target_seconds must be a number");
  }
  if (raw <= 0 || raw > MAX_TARGET_SECONDS) {
    return fail(`target_seconds must be greater than 0 and at most ${MAX_TARGET_SECONDS}`);
  }
  return { ok: true, value: raw };
}

function validateBool(raw: unknown, field: string): ValidationResult<boolean> {
  if (typeof raw !== "boolean") return fail(`${field} must be a boolean`);
  return { ok: true, value: raw };
}

/** Validate an array-of-strings field and de-duplicate (order-preserving). */
function validateStringArray(raw: unknown, field: string): ValidationResult<string[]> {
  if (!Array.isArray(raw)) return fail(`${field} must be an array of strings`);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") return fail(`${field} must contain only strings`);
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return { ok: true, value: out };
}

/**
 * Enforce the filter-array ↔ type matrix:
 * - coding: every filter array must be empty.
 * - languages/editors/projects: the matching array must be non-empty, the
 *   other two empty.
 * `arrays` only contains fields the caller actually supplied.
 */
function checkFilterConsistency(
  type: GoalType,
  arrays: Partial<Record<FilterField, string[]>>,
): string | null {
  const required = FILTER_FIELD[type];
  for (const field of FILTER_FIELDS) {
    const provided = arrays[field];
    if (provided === undefined) continue;
    if (field === required) {
      if (provided.length === 0) {
        return `${field} must be a non-empty array for a ${type} goal`;
      }
    } else if (provided.length > 0) {
      return `${field} must be empty for a ${type} goal`;
    }
  }
  return null;
}

/**
 * Validate a create (POST) body. Server-generated fields (id, created_at,
 * modified_at) are ignored if present. Booleans default when omitted.
 */
export function validateGoalInput(body: unknown): ValidationResult<ValidatedGoalCreate> {
  if (!isPlainObject(body)) return fail("Request body must be a JSON object");

  const title = validateTitle(body.title);
  if (!title.ok) return title;

  if (!GOAL_TYPES.includes(body.type as GoalType)) {
    return fail(`type must be one of ${GOAL_TYPES.join(", ")}`);
  }
  const type = body.type as GoalType;

  if (!GOAL_DELTAS.includes(body.delta as GoalDelta)) {
    return fail(`delta must be one of ${GOAL_DELTAS.join(", ")}`);
  }
  const delta = body.delta as GoalDelta;

  const target = validateTargetSeconds(body.target_seconds);
  if (!target.ok) return target;

  const booleans: Record<"is_enabled" | "is_snoozed" | "is_inverse", boolean> = {
    is_enabled: true,
    is_snoozed: false,
    is_inverse: false,
  };
  for (const field of ["is_enabled", "is_snoozed", "is_inverse"] as const) {
    if (body[field] !== undefined) {
      const b = validateBool(body[field], field);
      if (!b.ok) return b;
      booleans[field] = b.value;
    }
  }

  const arrays: Record<FilterField, string[]> = { languages: [], editors: [], projects: [] };
  for (const field of FILTER_FIELDS) {
    if (body[field] !== undefined) {
      const arr = validateStringArray(body[field], field);
      if (!arr.ok) return arr;
      arrays[field] = arr.value;
    }
  }

  // Create validates the full set: an omitted required filter array defaults
  // to [] and must therefore fail the non-empty check.
  const consistencyError = checkFilterConsistency(type, arrays);
  if (consistencyError) return fail(consistencyError);

  return {
    ok: true,
    value: {
      title: title.value,
      type,
      delta,
      target_seconds: target.value,
      is_enabled: booleans.is_enabled,
      is_snoozed: booleans.is_snoozed,
      is_inverse: booleans.is_inverse,
      languages: arrays.languages,
      editors: arrays.editors,
      projects: arrays.projects,
    },
  };
}

/**
 * Validate a partial update (PATCH) body against the goal's existing type.
 * `type` and `delta` are immutable; an empty update is rejected. Only the
 * provided fields appear in the result.
 */
export function validateGoalUpdate(
  body: unknown,
  existingType: GoalType,
): ValidationResult<ValidatedGoalUpdate> {
  if (!isPlainObject(body)) return fail("Request body must be a JSON object");

  if ("type" in body || "delta" in body) {
    return fail("type and delta are immutable; delete and recreate to change them");
  }

  const value: ValidatedGoalUpdate = {};
  const suppliedArrays: Partial<Record<FilterField, string[]>> = {};

  if (body.title !== undefined) {
    const title = validateTitle(body.title);
    if (!title.ok) return title;
    value.title = title.value;
  }

  if (body.target_seconds !== undefined) {
    const target = validateTargetSeconds(body.target_seconds);
    if (!target.ok) return target;
    value.target_seconds = target.value;
  }

  for (const field of ["is_enabled", "is_snoozed", "is_inverse"] as const) {
    if (body[field] !== undefined) {
      const b = validateBool(body[field], field);
      if (!b.ok) return b;
      value[field] = b.value;
    }
  }

  for (const field of FILTER_FIELDS) {
    if (body[field] !== undefined) {
      const arr = validateStringArray(body[field], field);
      if (!arr.ok) return arr;
      value[field] = arr.value;
      suppliedArrays[field] = arr.value;
    }
  }

  if (Object.keys(value).length === 0) {
    return fail("Request body must contain at least one mutable field");
  }

  const consistencyError = checkFilterConsistency(existingType, suppliedArrays);
  if (consistencyError) return fail(consistencyError);

  return { ok: true, value };
}
