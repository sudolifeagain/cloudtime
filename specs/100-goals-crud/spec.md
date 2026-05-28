# Feature Specification: Goals CRUD Endpoints

**Feature Branch**: `100-goals-crud`
**Created**: 2026-05-28
**Status**: Draft
**Input**: PR #95 / #96 shipped the Goals **read** path (`getGoals`, `getGoal`) and explicitly deferred mutation. The `goals` D1 table already carries every persisted column. This feature adds the create / update / delete surface so self-hosted operators stop managing goals with raw `wrangler d1 execute`.

## Background

A goal expresses an intent to spend at least (or, when `is_inverse`, at most) `target_seconds` of coding time per `delta` period, optionally scoped to a set of languages, editors, or projects. The read endpoints already serialise these rows and compute progress charts. Today the only way to create, edit, or remove a goal is a direct SQL statement against D1 — impractical and unsafe for operators.

This spec covers the **mutation path only**: `POST /users/current/goals`, `PATCH /users/current/goals/{goal_id}`, and `DELETE /users/current/goals/{goal_id}`. It reuses the existing `Goal` response shape and the existing `goals` table. No schema migration is required.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create a goal (Priority: P1)

As an authenticated user, I want to create a goal through the API so that the goals UI and the read endpoints have something to show without me touching the database.

**Why this priority**: Create is the entry point — without it the read endpoints only ever reflect manually-seeded rows.

**Independent Test**: Authenticate, `POST /users/current/goals` with a minimal valid body (`title`, `type=coding`, `delta=day`, `target_seconds=3600`), and verify a 201 with the persisted `Goal` echoed back, including a server-generated `id`, `created_at`, `modified_at`, and the defaulted booleans.

**Acceptance Scenarios**:

1. **Given** a valid `type=coding` body, **When** the user POSTs it, **Then** the server returns 201 with `{"data": Goal}`, a fresh UUID `id`, `is_enabled=true`, `is_snoozed=false`, `is_inverse=false`, and empty filter arrays.
2. **Given** a body that omits the booleans, **When** the goal is created, **Then** defaults are applied (`is_enabled=true`, the others `false`).
3. **Given** a `type=languages` body with `languages=["TypeScript"]`, **When** created, **Then** the persisted goal stores the JSON array and the response echoes `languages: ["TypeScript"]`.
4. **Given** any server-generated field (`id` / `created_at` / `modified_at`) in the request body, **When** created, **Then** the server ignores them and assigns its own values.
5. **Given** an unauthenticated request, **When** POSTing, **Then** the server returns 401 and creates nothing.

---

### User Story 2 - Edit a goal (Priority: P1)

As an authenticated user, I want to adjust a goal's title, target, flags, or filter sets without recreating it, so I keep its chart history.

**Why this priority**: Goals are long-lived; users routinely retune targets and snooze/unsnooze. Editing is the most frequent mutation.

**Independent Test**: Create a goal, `PATCH` it with `{"target_seconds": 7200, "is_snoozed": true}`, and verify a 200 with only those two fields changed, `modified_at` advanced, and every untouched field preserved.

**Acceptance Scenarios**:

1. **Given** an owned goal, **When** the user PATCHes a subset of mutable fields, **Then** only those fields change, `modified_at` is bumped, and the response is `{"data": Goal}` with the merged state.
2. **Given** a PATCH body containing `type` or `delta`, **When** submitted, **Then** the server returns 400 (both are immutable) and changes nothing.
3. **Given** an empty PATCH body `{}`, **When** submitted, **Then** the server returns 400 (no-op updates are rejected, not silently accepted).
4. **Given** a goal owned by a different user, **When** the caller PATCHes it, **Then** the server returns 404 (not 403) and changes nothing.
5. **Given** an unknown `goal_id`, **When** PATCHed, **Then** the server returns 404.
6. **Given** an unauthenticated request, **When** PATCHing, **Then** the server returns 401.

---

### User Story 3 - Delete a goal (Priority: P1)

As an authenticated user, I want to remove a goal I no longer care about so it stops appearing in lists and charts.

**Why this priority**: Without delete, abandoned goals accumulate and clutter every list response forever.

**Independent Test**: Create a goal, `DELETE` it, observe 204, then confirm a follow-up `GET /goals/{id}` returns 404 and the list no longer contains it.

**Acceptance Scenarios**:

1. **Given** an owned goal, **When** the user DELETEs it, **Then** the server returns 204 with no body and the row is gone.
2. **Given** a goal owned by a different user, **When** the caller DELETEs it, **Then** the server returns 404 and deletes nothing.
3. **Given** an unknown `goal_id`, **When** DELETEd, **Then** the server returns 404 (idempotent-looking but never reports success for a row it did not delete).
4. **Given** an unauthenticated request, **When** DELETEing, **Then** the server returns 401.

---

### Edge Cases

- **Title whitespace-only**: `"   "` is treated as empty after trim → 400.
- **`target_seconds` boundaries**: `0` and negative → 400. Exactly `604800` (one week) is accepted; above it → 400.
- **Filter array on the wrong type**: `type=coding` with a non-empty `languages` array → 400. `type=languages` with an empty or omitted `languages` array → 400.
- **Filter array with non-string members**: arrays must be of strings; a number/object member → 400.
- **Duplicate filter values**: `["Go","Go"]` is de-duplicated server-side; not an error.
- **PATCH that switches a filtered goal's array to empty**: a `type=languages` goal PATCHed with `languages=[]` → 400 (a filtered goal must keep a non-empty allowlist; to stop filtering, delete and recreate as `type=coding`).
- **PATCH unknown/unexpected keys**: ignored (forward-compatible) — only recognised mutable fields are read.
- **Concurrent PATCH/DELETE**: last write wins; a PATCH against a row deleted concurrently returns 404.
- **Body not valid JSON / wrong content type**: 400.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `POST /api/v1/users/current/goals` MUST create one goal owned by the authenticated user and return `201` with `{"data": Goal}` (persisted fields only, no `chart_data`).
- **FR-002**: The server MUST generate `id` (UUID), `created_at`, and `modified_at`; any of these present in the request body MUST be ignored.
- **FR-003**: `title` MUST be a non-empty string after trimming, at most 200 characters; otherwise 400.
- **FR-004**: `type` MUST be one of `coding | languages | editors | projects`; `delta` MUST be one of `day | week`; otherwise 400.
- **FR-005**: `target_seconds` MUST be a number with `0 < target_seconds <= 604800`; otherwise 400.
- **FR-006**: Filter-array consistency MUST be enforced on create: `type=coding` requires all of `languages` / `editors` / `projects` to be empty or omitted; `type=languages|editors|projects` requires the matching array to be a non-empty array of strings and the other two to be empty or omitted. Violations return 400.
- **FR-007**: Booleans default when omitted: `is_enabled=true`, `is_snoozed=false`, `is_inverse=false`.
- **FR-008**: `PATCH /api/v1/users/current/goals/{goal_id}` MUST partially update an owned goal and return `200` with `{"data": Goal}` reflecting the merged state. Only `title`, `target_seconds`, `is_enabled`, `is_snoozed`, `is_inverse`, `languages`, `editors`, `projects` are mutable.
- **FR-009**: `type` and `delta` are immutable. A PATCH body containing either MUST return 400 and mutate nothing.
- **FR-010**: A PATCH body with no recognised mutable field (including `{}`) MUST return 400.
- **FR-011**: PATCH MUST apply the same per-field validation as create (FR-003, FR-005) to any field it does set, and MUST keep filter arrays consistent with the goal's existing `type` (FR-006). A filtered goal's array MUST remain non-empty.
- **FR-012**: PATCH MUST advance `modified_at` and leave `created_at` unchanged.
- **FR-013**: `DELETE /api/v1/users/current/goals/{goal_id}` MUST delete an owned goal and return `204` with no body.
- **FR-014**: PATCH and DELETE against a goal not owned by the caller, or an unknown `goal_id`, MUST return 404 (never 403, never 200/204) and mutate nothing.
- **FR-015**: All three endpoints MUST require API-key or session authentication; an unauthenticated request returns 401 and mutates nothing.
- **FR-016**: `languages` / `editors` / `projects` MUST be persisted as JSON-encoded TEXT (same encoding the read path decodes), with duplicate members removed before storage.
- **FR-017**: Validation errors MUST return the project's standard `400` body (`{"error": "<message>"}`) with a message that names the offending field, and MUST NOT echo back secrets or the raw body.

### Non-Functional Requirements

- **NFR-001**: Each endpoint MUST complete within the Workers free-tier 10ms CPU budget. Create/update/delete are single-row writes; create issues at most one `INSERT`, update one `UPDATE` (after one ownership `SELECT`), delete one `DELETE`.
- **NFR-002**: Mutations MUST be scoped by `user_id` in the SQL `WHERE` clause so cross-user access is impossible even if a `goal_id` is guessed.
- **NFR-003**: No new dependency, env var, or D1 migration. The feature uses only the existing `goals` table and `crypto.randomUUID()`.

### Key Entities *(no schema change)*

No schema changes. The `goals` table already has `id`, `user_id`, `title`, `type`, `delta`, `target_seconds`, `is_enabled`, `is_snoozed`, `is_inverse`, `languages`, `editors`, `projects`, `created_at`, `modified_at`, and `ON DELETE CASCADE` from `users`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can create, edit, and delete a goal end-to-end through the API with no direct D1 access.
- **SC-002**: A created goal is immediately visible via `GET /goals` and `GET /goals/{id}` with the values supplied.
- **SC-003**: Every validation rule in FR-003..FR-006, FR-009..FR-011 returns 400 with a field-naming message (covered by integration tests).
- **SC-004**: Cross-user PATCH/DELETE returns 404 and leaves the target row untouched (verified by a second-user read).
- **SC-005**: A deleted goal returns 404 on a subsequent GET and is absent from the list.
- **SC-006**: New handler code in `src/routes/goals.ts` reuses the existing `rowToGoal` decoder and adds shared validation helpers; no duplication of the read decoder.

## Out of Scope

- **Bulk create / bulk delete**. One goal per request; batch endpoints are deferred.
- **`type` / `delta` mutation**. Immutable by design; recreate to change them.
- **Goal templates, suggestions, or auto-creation** from activity.
- **Notifications / reminders** when a goal flips status.
- **Soft delete / archive**. `DELETE` is a hard delete; "hide without deleting" is what `is_enabled=false` already provides.
- **Reordering goals**. List order stays `created_at` ascending.
- **Custom week-start** or per-goal timezone. Inherited from the read-path decisions.
