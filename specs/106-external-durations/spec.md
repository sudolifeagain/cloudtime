# Feature Specification: External Durations

**Feature Branch**: `106-external-durations`
**Created**: 2026-05-29
**Status**: Draft
**Input**: The `external_durations` D1 table and four OpenAPI operations (`getExternalDurations`, `createExternalDuration`, `createExternalDurationsBulk`, `deleteExternalDurationsBulk`) are declared, but no route is mounted.

## Background

External durations let a user push **non-coding** time into the same timeline — calendar events, meeting blocks, manually logged planning time — typically synced from an external source (Google Calendar, Zoom, etc.). Each entry carries an `external_id` from its source system so syncs are replayable.

This feature wires the four declared operations to handlers backed by the existing `external_durations` table. It is **low priority** for single-user (only useful when a user actively pipes external time), but the table and contract already exist, so wiring them is small and self-contained.

## Spec-level decisions (resolved in this PR)

- **Idempotent on `(user_id, external_id)`**: create / bulk-create upsert on the existing unique constraint, so re-syncing the same source event updates in place instead of erroring or duplicating.
- **Parallel series, not merged into `summaries`**: external durations are non-coding time. Folding them into `summaries` would contaminate the coding metrics behind `/stats`, `/summaries`, goals, and insights. They stay a separate series exposed only by `GET /external_durations`. The cron aggregator is **not** touched.
- **Bulk cap = 100**: the declared schema says `maxItems: 100`. Per the SDD rule (OpenAPI is the single source of truth) this wins over the issue's prose "max 25"; 100 also suits calendar imports.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Push external time (Priority: P2)

As an authenticated user, I want to create external durations (single or batch) so my non-coding time appears alongside my coding timeline.

**Independent Test**: `POST /external_durations` with a valid body returns 201 with the stored row (server `id`, `user_id`, `created_at`). Re-POST the same `external_id` with a new `end_time`; the row updates in place (no duplicate, same `id` row by `external_id`).

**Acceptance Scenarios**:
1. **Given** a valid body, **When** POSTing, **Then** 201 with `{data: ExternalDuration}` echoing the input plus server fields.
2. **Given** a duplicate `external_id`, **When** POSTing again, **Then** the existing `(user_id, external_id)` row is updated (idempotent), not duplicated.
3. **Given** a body missing a required field / unknown `type` / `end_time` < `start_time`, **When** POSTing, **Then** 400 and nothing stored.
4. **Given** a bulk array, **When** POSTing to `.bulk`, **Then** 201 with `{data: ExternalDuration[]}` for all items.
5. **Given** a bulk array with one invalid element, **When** POSTing, **Then** 400 and **nothing** is written (all-or-nothing).
6. **Given** > 100 items, **When** POSTing to `.bulk`, **Then** 400.
7. **Given** an unauthenticated request, **Then** 401 and nothing stored.

---

### User Story 2 - List external time for a day (Priority: P2)

As an authenticated user, I want to list a day's external durations so a client can render them.

**Independent Test**: Seed durations across two days. `GET /external_durations?date=YYYY-MM-DD` returns only the entries whose `start_time` is on that day (in the user's timezone), ordered ascending.

**Acceptance Scenarios**:
1. **Given** durations on several days, **When** listing for one `date`, **Then** only that day's entries (by `start_time`) return, ascending.
2. **Given** `project` / `branches` filters, **When** listing, **Then** only matching entries return.
3. **Given** no `date`, **When** listing, **Then** 400.
4. **Given** another user's durations, **When** listing, **Then** none appear.
5. **Given** an unauthenticated request, **Then** 401.

---

### User Story 3 - Delete external time (Priority: P2)

As an authenticated user, I want to remove external durations I no longer want.

**Acceptance Scenarios**:
1. **Given** owned durations, **When** `DELETE .bulk` with `{date, ids}`, **Then** matching rows on that day are removed; 204.
2. **Given** ids not owned / unknown, **When** deleting, **Then** they are ignored (no error); owned matches still deleted; 204.
3. **Given** a malformed body (no `date`/`ids`, bad `date`), **Then** 400.
4. **Given** an unauthenticated request, **Then** 401.

---

### Edge Cases

- **`end_time` == `start_time`**: allowed (zero-length marker). `end_time` < `start_time` → 400.
- **`type` outside `file|app|domain`**: 400.
- **Cross-user `external_id` collision**: none — the unique key is `(user_id, external_id)`, scoped per user.
- **Bulk with duplicate `external_id` within one request**: the last one wins after the upserts apply; not an error.
- **Timezone**: `date` is interpreted in the `timezone` query param if provided, else the user's profile timezone (same as `GET /heartbeats`).
- **Invalid timezone**: unrecognised IANA timezone values return 400 instead of falling through to a worker exception.
- **Unknown ids in delete**: silently ignored (delete is scoped by `id IN (…) AND user_id`).

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `POST /api/v1/users/current/external_durations` MUST create one external duration and return `201` with `{data: ExternalDuration}`. It MUST upsert on `(user_id, external_id)` (re-sent `external_id` updates in place).
- **FR-002**: The server MUST generate `id` and `created_at`; `user_id` comes from the session. Validation: `external_id`, `entity`, `type ∈ {file,app,domain}`, `start_time`, `end_time` required and numeric; `end_time` ≥ `start_time`. Violations → 400, nothing stored.
- **FR-003**: `POST /api/v1/users/current/external_durations.bulk` MUST validate every element first and, only if all pass, upsert them in one batch returning `{data: ExternalDuration[]}` (201). Any invalid element → 400, nothing written. > 100 elements → 400.
- **FR-004**: `GET /api/v1/users/current/external_durations?date=YYYY-MM-DD` MUST return the user's durations whose `start_time` is within that local day, ordered by `start_time` ascending, as `{data: ExternalDuration[]}`. Optional `project` and `branches` (comma-separated) filter further. Missing/invalid `date` or invalid `timezone` -> 400.
- **FR-005**: `DELETE /api/v1/users/current/external_durations.bulk` with `{date, ids}` MUST delete the user's matching durations on that day and return `204`. Unknown/unowned ids are ignored. Malformed body → 400.
- **FR-006**: All endpoints MUST require authentication (401) and be strictly scoped by `user_id`.
- **FR-007**: External durations MUST NOT be aggregated into `summaries`; the cron aggregator is unchanged. They are exposed only via `GET /external_durations`.

### Non-Functional Requirements

- **NFR-001**: Bulk create MUST use a single `db.batch()` (one statement per element); no per-row round-trip. Bounded at 100 elements.
- **NFR-002**: No D1 schema migration; the `external_durations` table already exists with `UNIQUE(user_id, external_id)`.
- **NFR-003**: GET MUST issue a single indexed `SELECT` (the `idx_ext_durations_user_time` index covers `user_id, start_time`).

### Key Entities *(no schema change)*

`external_durations` (`id`, `user_id`, `external_id`, `entity`, `type`, `category`, `start_time`, `end_time`, `project`, `branch`, `language`, `meta`, `created_at`, `UNIQUE(user_id, external_id)`, `ON DELETE CASCADE`). Response uses the existing `ExternalDuration` / `ExternalDurationInput` schemas.

## Success Criteria *(mandatory)*

- **SC-001**: Create, bulk-create, list-by-day, and bulk-delete all work end-to-end against a seeded DB.
- **SC-002**: Re-sending an `external_id` updates rather than duplicates.
- **SC-003**: A bulk request with one invalid element writes nothing and returns 400.
- **SC-004**: Listing is day-scoped and user-scoped; cross-user never leaks.
- **SC-005**: `/stats` and `/summaries` are unchanged by the presence of external durations.

## Out of Scope

- **Aggregating external durations into summaries / stats / insights.** Parallel series only (FR-007).
- **A live calendar/Zoom integration.** This endpoint accepts pushed data; the source-side sync is a separate concern.
- **Per-id single DELETE.** Deletion is via the declared `.bulk` operation only.
- **Overlap/merge logic** between external durations and heartbeats.
