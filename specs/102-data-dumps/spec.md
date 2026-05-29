# Feature Specification: Data Dumps (Export)

**Feature Branch**: `102-data-dumps`
**Created**: 2026-05-29
**Status**: Draft
**Input**: The `data_dumps` D1 table and the `getDataDumps` / `createDataDump` OpenAPI operations exist, but no route is implemented. Users cannot export their own data via the API.

## Background

A user-facing self-service export supports migration (between CloudTime instances, or to/from WakaTime-compatible tooling), personal backup, and data-portability hygiene — distinct from operator-side D1 backups. A dump is requested, built asynchronously, and made available at a short-lived URL for a limited window.

## Spec-level decisions (resolved in this PR)

- **R2-gated, fail-closed**: the feature requires a bound R2 bucket (`R2_BUCKET`). When it is not bound, both endpoints return **503** ("Data export not configured") — the same pattern as email delivery (`EMAIL_PROVIDER`). Operators opt in by binding R2.
- **Async via the existing hourly cron sweep** (not Cloudflare Queues): `POST` records a `pending` dump; the hourly cron builds pending dumps and purges expired ones. This avoids a new Queue binding and reuses the established cron.
- **`type` = `daily | full`** (reconciled from the declared `daily | heartbeats`): `daily` exports per-day summaries; `full` bundles user profile + summaries + per-day records + raw heartbeats. This matches the issue's stated scope and the portability use case. *(Flagged for review — supersedes the prior `heartbeats` enum value.)*
- **`status` adds `expired`**: lifecycle is `pending → processing → completed | failed`, plus `expired` once past `expires_at` and the stored object is purged.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Request and download an export (Priority: P2)

As an authenticated user, I want to request an export and later download it, so I can migrate or back up my data.

**Independent Test**: With R2 bound, `POST /data_dumps {type:"full"}` returns 201 with a `pending` dump. After the cron sweep runs, `GET /data_dumps` shows that dump `completed` with a `download_url`; fetching the URL returns the bundle.

**Acceptance Scenarios**:
1. **Given** R2 is bound, **When** POSTing a valid `type`, **Then** 201 with `{data: DataDump}` `status=pending`, `id`, `created_at`.
2. **Given** a pending dump, **When** the cron sweep runs, **Then** it transitions to `processing` then `completed`, with `download_url` and `expires_at` (≈ now + 7 days) set.
3. **Given** a completed dump, **When** the user GETs the list, **Then** the entry includes the `download_url`.
4. **Given** an unknown `type`, **When** POSTing, **Then** 400.
5. **Given** R2 is **not** bound, **When** POSTing or listing, **Then** 503 and nothing is created.
6. **Given** an unauthenticated request, **Then** 401.

---

### User Story 2 - List my exports with status (Priority: P2)

As an authenticated user, I want to see my exports and their status so I know when one is ready.

**Acceptance Scenarios**:
1. **Given** several dumps, **When** listing, **Then** they return newest-first with `status` and (when completed) `download_url`.
2. **Given** another user's dumps, **When** listing, **Then** none appear.
3. **Given** a dump past `expires_at`, **When** listing, **Then** its `status` is `expired` and it has no `download_url`.

---

### Edge Cases

- **Duplicate request**: a `POST` for a `type` that already has a `pending`/`processing` dump returns the existing dump rather than queuing a duplicate (idempotent-ish; bounds work).
- **R2 unbound mid-flight**: if R2 becomes unavailable during processing, the dump is marked `failed` (cron logs); the user can retry.
- **`full` with no data**: produces a valid bundle with empty arrays.
- **Expiry**: the cron purges the R2 object and marks the row `expired`; a later download attempt 404s.
- **`email_when_finished`**: accepted but only acts when email delivery is configured (multi-user); a no-op in single-user.
- **Large heartbeat volume**: `full` may be large; it is built in the cron (off the request hot path) and streamed to R2.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `POST /api/v1/users/current/data_dumps` MUST, when R2 is bound, create a `data_dumps` row with `status=pending` for `type ∈ {daily, full}` and return `201 {data: DataDump}`. Unknown `type` → 400.
- **FR-002**: Both `data_dumps` endpoints MUST be gated on a bound `R2_BUCKET`; when unbound they MUST return `503` and create/return nothing.
- **FR-003**: `GET /api/v1/users/current/data_dumps` MUST return the user's dumps newest-first with `status`, and `download_url` when `status=completed` and not yet expired.
- **FR-004**: The hourly cron MUST process `pending` dumps: set `processing`, build the export, upload it to R2, set `download_url` + `expires_at` (default now + 7 days) + `status=completed`; on error set `status=failed`.
- **FR-005**: `daily` MUST export per-day summary buckets; `full` MUST bundle user profile + summaries + per-day records + raw heartbeats.
- **FR-006**: The cron MUST purge expired dumps: delete the R2 object and mark the row `expired` (download then 404s).
- **FR-007**: `download_url` MUST be short-lived and only resolve for the owning user; an expired or unauthorized fetch MUST fail (no public, durable links).
- **FR-008**: A `POST` while a `pending`/`processing` dump of the same `type` exists MAY return that existing dump instead of creating a duplicate.
- **FR-009**: All endpoints MUST require authentication (401) and be strictly scoped by `user_id`.

### Non-Functional Requirements

- **NFR-001**: Building a dump MUST happen in the cron (off the request path); the `POST`/`GET` handlers MUST stay within the 10ms CPU budget (single-row write / bounded user-scoped list).
- **NFR-002**: No new external dependency. R2 access uses the Workers R2 binding. The async path reuses the existing hourly cron (no Queues binding).
- **NFR-003**: No D1 schema migration — the `data_dumps` table already exists.

### Key Entities *(no schema change)*

`data_dumps` (`id`, `user_id`, `type`, `status`, `download_url`, `created_at`, `expires_at`, `ON DELETE CASCADE`). Response uses the existing `DataDump` schema (with the reconciled `type`/`status` enums). R2 objects are keyed per dump (e.g. `dumps/{user_id}/{dump_id}.json`).

## Success Criteria *(mandatory)*

- **SC-001**: With R2 bound, a requested dump is built by the cron and becomes downloadable, then expires after 7 days.
- **SC-002**: Without R2 bound, both endpoints return 503 and the feature is inert (safe to ship un-provisioned).
- **SC-003**: A `full` export round-trips the user's data (user/summaries/daily/heartbeats) in a documented JSON shape.
- **SC-004**: Cross-user listing/download never leaks another user's dump; unauthorized/expired downloads fail.

## Out of Scope

- **Import** (the reverse of export).
- **Cloudflare Queues** (the async path is the existing cron sweep).
- **Incremental / diff exports** (each dump is a full snapshot of its `type`).
- **Zip/compression** in the first cut (JSON bundle; compression can follow).
- **Presigned S3-style URLs requiring R2 S3 credentials** if a worker-mediated download is chosen in PR2 (see research).
