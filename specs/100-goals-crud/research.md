# Research: Goals CRUD Endpoints

## Decision 1: `type` and `delta` are immutable

**Decision**: `PATCH` rejects any body containing `type` or `delta` with a 400. To change either, the client deletes the goal and creates a new one.

**Rationale**:
- The goal's chart is computed by reinterpreting historical `summaries` against the goal's `type` filter and `delta` period. Mutating `type` from `coding` to `languages`, or `delta` from `day` to `week`, would silently rewrite the meaning of every past period — the same row would suddenly show different history.
- Keeping them immutable means the read path never has to reason about "what was the type when this period happened."
- The issue (#100) lists the editable fields as `title`, `target_seconds`, `is_enabled`, `is_snoozed`, `is_inverse`, and the filter arrays — `type` / `delta` are deliberately absent.

**Alternative considered**:
- **Allow `type` / `delta` change**: would require either versioning goals or accepting that historical charts shift. Rejected as surprising; recreate is cheap.

---

## Decision 2: Cross-user / unknown target returns 404, not 403

**Decision**: `PATCH` and `DELETE` against a `goal_id` the caller does not own — or one that does not exist — both return 404. The SQL `WHERE` clause always includes `user_id = ?`, so "not yours" and "not found" are indistinguishable by construction.

**Rationale**:
- Matches the read path (`getGoal`), which the spec for 100-goals-read fixed at 404 to avoid leaking goal-id existence.
- A single `WHERE id = ? AND user_id = ?` clause is the simplest correct implementation and removes the temptation to fetch-then-check (a TOCTOU window).

**Alternative considered**:
- **403 for owned-by-other**: clearer for debugging but leaks that the id exists. Rejected on least-information grounds, consistent with read.

---

## Decision 3: `DELETE` is a hard delete returning 204

**Decision**: `DELETE` removes the row outright and returns 204 with no body. There is no soft-delete / archive flag.

**Rationale**:
- `is_enabled=false` already provides "keep the goal but hide/dim it" semantics (the read path returns disabled goals so clients can choose to hide them). A separate archive state would duplicate that.
- 204 is the conventional REST response for a successful delete with no representation to return; it mirrors `deleteCustomRule` in the existing schema.
- `goals` has `ON DELETE CASCADE` from `users`, so there are no dependent rows to clean up.

**Alternative considered**:
- **Soft delete (`deleted_at`)**: adds a column and forces every read query to filter it. Rejected — `is_enabled` covers the real use case.

---

## Decision 4: Empty PATCH body is a 400, not a silent no-op

**Decision**: A `PATCH` whose body contains no recognised mutable field (including `{}`) returns 400.

**Rationale**:
- An empty update almost always indicates a client bug (wrong field names, serialisation error). Returning 200 for it hides the mistake.
- It keeps the "PATCH advanced `modified_at`" guarantee meaningful — we never bump `modified_at` for a request that changed nothing.

**Alternative considered**:
- **200 no-op**: friendlier but masks client errors and muddies `modified_at` semantics. Rejected.

---

## Decision 5: Validation is a pure module returning a discriminated result

**Decision**: `src/utils/goal-input.ts` exports `validateGoalInput` and `validateGoalUpdate`, each returning `{ ok: true, value } | { ok: false, error }`. Handlers only translate the result into a 400 or a DB write.

**Rationale**:
- The validation rules (title length, target range, type/delta enums, filter-array/type consistency) are the bulk of the logic and are pure functions of the input — ideal for fast unit tests without spinning up D1.
- Keeps handlers thin and mirrors the read path's `goal-chart.ts` pure-helper split.
- A discriminated result avoids throwing for expected validation failures.

**Alternative considered**:
- **Inline validation in the handler**: harder to unit-test and tends to drift between POST and PATCH. Rejected.
- **A schema-validation library (zod, etc.)**: a new dependency for rules we can express in a few guards. Rejected per Simplicity First; the OpenAPI schema already documents the contract.

---

## Decision 6: Filter arrays are de-duplicated and stored as JSON TEXT

**Decision**: `languages` / `editors` / `projects` are validated as arrays of strings, de-duplicated (order-preserving), and stored as JSON-encoded TEXT — the exact encoding the read path's `parseFilterArray` already decodes.

**Rationale**:
- The read decoder is the contract for the column format; the write path must produce what it consumes. Storing JSON TEXT keeps a single source of truth for the encoding.
- De-duplication avoids a `language IN ('Go','Go')` situation that would not change results but is noise.

**Alternative considered**:
- **A join table (`goal_filters`)**: normalised but adds a table, a migration, and multi-row writes for a feature that the read path already models as JSON. Rejected — out of scope and contradicts the existing column shape.

---

## Decision 7: Two request schemas (`GoalInput` + `GoalUpdate`)

**Decision**: `GoalInput` (create) declares `title`, `type`, `delta`, `target_seconds` as required with optional booleans/arrays. `GoalUpdate` (PATCH) declares every mutable field optional and omits `type` / `delta` entirely.

**Rationale**:
- The two operations have genuinely different contracts: create must establish `type`/`delta`; update must not touch them. Encoding that in two schemas makes the generated TypeScript types tell the truth (`GoalInput.type` is required; `GoalUpdate` has no `type`).
- A single all-optional schema would force the handler — and every reader of the generated types — to re-derive which fields are required for which verb.

**Alternative considered**:
- **One `GoalInput` reused for both** (issue's literal wording): would either make create's required fields optional (losing the contract) or force PATCH clients to resend `type`/`delta`. The issue's intent (edit a subset, don't touch type/delta) is better served by the split; documented here so the deviation from the issue's single-schema phrasing is intentional and reviewable.

---

## Decision 8: Defaults applied server-side, not via schema `default`

**Decision**: `is_enabled=true`, `is_snoozed=false`, `is_inverse=false` defaults are applied in the validation module, and the booleans are optional in `GoalInput` (no OpenAPI `default` keyword).

**Rationale**:
- `openapi-typescript` emits properties carrying a `default` as required in the generated type, which is wrong for an optional create field. Documenting the default in the property description keeps the field optional in the type while still telling clients what omission means.
- No other `*Input` schema in the repo uses `default:`, so this stays consistent.

**Alternative considered**:
- **Keep schema `default:`**: nicer for doc renderers but pollutes the generated request type with required booleans. Rejected for type accuracy and repo consistency.
