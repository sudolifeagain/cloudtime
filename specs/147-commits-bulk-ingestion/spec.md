# Feature Specification: Bulk commit ingestion

**Feature Branch**: `147-commits-bulk-ingestion`
**Created**: 2026-07-09
**Status**: Draft
**Input**: Single-commit ingestion exists (`POST /users/current/projects/{project}/commits`, #135) and derives `total_seconds` from heartbeats when omitted (#145). A git push (or a webhook adapter) usually carries **many** commits; posting them one-by-one is N round trips. Add a bulk endpoint mirroring `heartbeats.bulk` / `external_durations.bulk`. Issue #147.

## Background

Commit ingestion (#135) accepts one commit per request. That is fine for a `post-commit` hook, but a `git push` — or a git-host webhook adapter (#146) — typically delivers a whole range of commits at once, so a caller must fan the push into N separate `POST`s (N HTTP round trips, N auth checks, N writes).

This feature adds a **bulk ingestion endpoint** — `POST /users/current/projects/{project}/commits.bulk` — that accepts a JSON array of commits and persists them in a **single** `db.batch()` of idempotent upserts, returning the stored `Commit[]`. It mirrors the existing `heartbeats.bulk` / `external_durations.bulk` shape and reuses the single endpoint's validation (`validateCommitInput`) and upsert SQL unchanged.

**One deliberate difference from the single endpoint (research D-3):** bulk ingestion does **not** correlate heartbeats to derive `total_seconds`. Per-element correlation is inherently O(N) additional D1 reads and per-element CPU over a bounded heartbeat window (#145), which would push a 100-element request past the Workers per-request CPU and subrequest budget that `docs/cloudflare-constraints.md` binds. In bulk, a client-supplied `total_seconds` (including an explicit `0`) is stored verbatim, and an omitted one is stored absent (the read path renders `"0 secs"`). A caller that wants server-derived time posts that commit through the single `POST .../commits` endpoint or supplies the value.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ingest a push of commits in one request (Priority: P1)

As an authenticated user (a git hook, CI step, or webhook adapter) whose push carries several commits, I want to post them all at once and read them back.

**Why this priority**: This is the feature — it removes the N-round-trip cost of the single endpoint for the common multi-commit case.

**Independent Test**: `POST /users/current/projects/cloudtime/commits.bulk` with an array of valid `CommitInput` returns `201` with `{ data: Commit[] }` in request order; a subsequent `GET .../commits` includes every posted commit and `GET .../commits/{hash}` returns each one.

**Acceptance Scenarios**:

1. **Given** an array of valid commit bodies, **When** posting to a project, **Then** `201` with `{ data: Commit[] }` in the same order and shape the single-create / read endpoints return, each stored under the authenticated `user_id` and the path `project`.
2. **Given** the posted commits, **When** listing the project's commits, **Then** all appear (newest-first by `author_date`), and each single-hash GET returns it.
3. **Given** an element carries `total_seconds`, **When** read back, **Then** `total_seconds` round-trips and `human_readable_total` derives from it; **given** an element omits `total_seconds`, **then** it is stored absent and `human_readable_total` is `"0 secs"` (bulk does not correlate heartbeats).

---

### User Story 2 - All-or-nothing validation (Priority: P1)

As a client author, I want the whole batch rejected if any element is invalid, so a partial write never leaves my commit history half-ingested.

**Why this priority**: Silent partial writes are hard to detect and reconcile; all-or-nothing keeps the batch a single atomic unit, matching `external_durations.bulk`.

**Independent Test**: A batch whose 3rd element has a blank `hash` returns `400` identifying that element, and a follow-up `GET .../commits` shows none of the batch's commits were written.

**Acceptance Scenarios**:

1. **Given** a batch where one element is invalid (missing/blank `hash`, negative/non-numeric `total_seconds`, or unparseable date), **When** posted, **Then** `400` with an error naming the failing element's index, and **nothing** is written.
2. **Given** a body that is not a JSON array, **When** posted, **Then** `400`.
3. **Given** a batch of more than the per-request cap (100) elements, **When** posted, **Then** `400` and nothing is written.
4. **Given** an empty array, **When** posted, **Then** `201` with `{ data: [] }` and nothing is written.

---

### User Story 3 - Re-posting commits is idempotent (Priority: P1)

As a hook/webhook author whose delivery may retry or whose push ranges overlap, I want re-sent commits to update in place, not duplicate.

**Why this priority**: Pushes and webhook redeliveries overlap; duplicates would corrupt lists and counts.

**Independent Test**: Post a batch containing `hash=abc`, then post another batch containing `abc` with a changed `message`; `GET .../commits` shows exactly one `abc`, with the updated fields.

**Acceptance Scenarios**:

1. **Given** a commit already stored for `(user, project, hash)`, **When** a later batch re-sends that `hash`, **Then** no duplicate row is created (dedup on `(user_id, project, hash)`), and its mutable fields reflect the latest values.
2. **Given** a single batch that lists the same `(project, hash)` twice, **When** posted, **Then** the upserts apply in array order and the last occurrence's values persist (consistent with re-posting); clients are advised to de-duplicate.
3. **Given** any batch, **Then** the response status is `201` (the upsert is an accepted write, mirroring the single-commit and external-durations convention).

### Edge Cases

- **Project from path**: the stored `project` is always the path segment; a `project` field inside any element is ignored (same as the single endpoint).
- **Omitted `total_seconds`**: stored absent; bulk does **not** derive it from heartbeats (unlike the single endpoint). Read path renders `"0 secs"`.
- **Omitted `author_date`**: allowed; stored null. The read path already renders a valid `author_date` by falling back to `created_at` (#128), so the response stays schema-valid.
- **Mixed supplied/omitted `total_seconds`** within one batch: each element is stored as given, independently.
- **Auth before validation**: an unauthenticated request returns `401` before the body is read or validated.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose `POST /users/current/projects/{project}/commits.bulk` that accepts a JSON array of commit bodies (`CommitInput[]`) and records them for the authenticated user under the path `project`.
- **FR-002**: Ingestion MUST be all-or-nothing: every element MUST be validated (the same rules as the single endpoint — `hash` required non-empty; `total_seconds` a number `>= 0` when present; `author_date`/`committer_date` valid date-times when present; field length caps) **before** any write. Any invalid element MUST return `400` identifying the failing element's array index, with nothing written.
- **FR-003**: The batch MUST be capped at 100 elements per request; a larger array MUST return `400` and write nothing. A body that is not a JSON array MUST return `400`. An empty array MUST return `201` with `{ data: [] }` and write nothing.
- **FR-004**: Each validated element MUST be upserted idempotently on `(user_id, project, hash)` in a **single** `db.batch()` (one D1 round-trip) — re-sending a `hash` updates the existing row's mutable fields (`message`, `author_*`, `committer_*`, `total_seconds`, `ref`, `url`) in place rather than inserting a duplicate.
- **FR-005**: `total_seconds` per element MUST be client-supplied and stored verbatim (including an explicit `0`); when omitted it MUST be stored absent. Bulk ingestion MUST NOT correlate heartbeats to derive `total_seconds` (contrast the single endpoint, #145).
- **FR-006**: On success the system MUST return `201` with `{ data: Commit[] }` in request order, each element in the same `Commit` shape the read and single-create endpoints return.
- **FR-007**: The endpoint MUST require authentication (Bearer API key); an unauthenticated request returns `401`, checked before the body is read or validated.
- **FR-008**: The stored `project` MUST come from the path and apply to every element; any `project` inside an element MUST be ignored.
- **FR-009**: Ingested commits MUST be immediately retrievable via the existing read endpoints (list + single), honoring their ordering and `author`/`branch` filters.
- **FR-010**: Ingestion MUST NOT alter unrelated aggregates (`summaries`, `hourly_summaries`, `user_projects`) — commits are an independent series.
- **FR-011**: The handler MUST stay within the Workers per-request budget: O(N) in-memory validation plus exactly one `db.batch()` write, with **no** per-element DB round-trip and **no** heartbeat scan.

### Key Entities

- **`commits`** (existing table, no schema change): `(user_id, project, hash)` is already `UNIQUE`, backing the idempotent upsert. The bulk endpoint writes the same columns the single endpoint writes, once per element, in one batch.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a bulk `POST` of N valid commits, all N are returned by `GET .../commits` and each by `GET .../commits/{hash}` for the same user/project.
- **SC-002**: A batch that re-sends already-stored hashes yields exactly one row per `(user, project, hash)`, reflecting the latest mutable-field values (no duplicates).
- **SC-003**: A batch with any invalid element returns `400` naming the element's index and writes nothing (verified by a follow-up read showing none of the batch persisted).
- **SC-004**: A commit ingested by user A is never visible to user B (cross-user isolation preserved).
- **SC-005**: An element's supplied `total_seconds` surfaces in `human_readable_total`; an omitted one yields `"0 secs"` — bulk never derives a value from heartbeats.
- **SC-006**: A full 100-element batch is persisted in a single D1 `db.batch()` (one round-trip), with no per-element read and no heartbeat query.
