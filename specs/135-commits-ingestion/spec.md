# Feature Specification: Commit ingestion (write path)

**Feature Branch**: `135-commits-ingestion`
**Created**: 2026-06-05
**Status**: Draft
**Input**: Commit **read** endpoints exist (`GET /users/current/projects/{project}/commits[/{hash}]`, #107), but there is no way to populate the `commits` table — ingestion was explicitly deferred. Issue #135.

## Background

CloudTime stores per-commit coding-time rows in the `commits` table and exposes them read-only. Until now the table could only be seeded out of band (tests insert rows directly). This feature adds a **first-party ingestion endpoint** so a git `post-commit` hook or a webhook adapter can record commits.

The ingestion model was chosen in design (research D-1): a **dedicated authenticated `POST`**, not a git-host webhook receiver and not commit context piggybacked on heartbeats. A commit's identity (hash) only exists at `git commit` time — not during the high-frequency heartbeat stream — so a small dedicated endpoint is the simplest correct contract and stays provider-agnostic. Any caller (a local hook, a CI step, or a webhook→HTTP adapter) posts a commit with an API key.

Per-commit coding time (`total_seconds`) is **client-supplied** and optional (research D-3); the server does not correlate heartbeats to compute it here. Server-side time attribution is a separable concern (out of scope, see below).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Record a commit and read it back (Priority: P1)

As an authenticated user (via a git hook), I want to post a commit so it appears in my project's commit list with its coding time.

**Why this priority**: This is the feature — without it the read endpoints have no data path.

**Independent Test**: `POST /users/current/projects/cloudtime/commits` with `{hash, message, author_*, ref, total_seconds}` returns 201 with `{data: Commit}`; a subsequent `GET .../commits` includes that commit, and `GET .../commits/{hash}` returns it.

**Acceptance Scenarios**:

1. **Given** a valid body with `hash`, **When** posting to a project, **Then** 201 with `{data: Commit}` in the same shape the read endpoints return, and the commit is stored under the authenticated `user_id` and the path `project`.
2. **Given** a posted commit, **When** listing the project's commits, **Then** it appears (newest-first by `author_date`), and a single-hash GET returns it.
3. **Given** `total_seconds` in the body, **When** read back, **Then** `total_seconds` round-trips and `human_readable_total` is derived from it; **given** `total_seconds` omitted, **then** it is stored null and `human_readable_total` is `"0 secs"`.

---

### User Story 2 - Re-posting the same commit is idempotent (Priority: P1)

As a hook author whose delivery may retry, I want re-posting the same commit to update the row in place, not duplicate it.

**Why this priority**: Hooks/webhooks retry; duplicates would corrupt counts and lists.

**Independent Test**: Post `hash=abc` twice (second with a changed `message` / `total_seconds`); `GET .../commits` shows exactly one `abc` with the updated fields.

**Acceptance Scenarios**:

1. **Given** a commit already stored for `(user, project, hash)`, **When** posting the same `hash` again, **Then** no duplicate row is created (dedup on `(user_id, project, hash)`).
2. **Given** the re-post carries changed mutable fields (`message`, author/committer, `total_seconds`, `ref`, `url`), **When** read back, **Then** the stored row reflects the new values.
3. **Given** either post, **Then** the response status is 201 (the upsert is treated as an accepted write, mirroring the external-durations convention).

---

### User Story 3 - Malformed input is rejected (Priority: P2)

As a client author, I want clear 400s for bad input so I can fix my request.

**Why this priority**: Prevents silently storing junk that breaks the read-path contract.

**Independent Test**: Posting without `hash`, with a blank `hash`, with a negative `total_seconds`, or with an unparseable `author_date` each returns 400.

**Acceptance Scenarios**:

1. **Given** a body missing `hash` or with an empty `hash`, **When** posted, **Then** 400.
2. **Given** `total_seconds` present but not a number `>= 0`, **When** posted, **Then** 400.
3. **Given** `author_date` or `committer_date` present but not a valid date-time, **When** posted, **Then** 400.
4. **Given** no/invalid credentials, **When** posted, **Then** 401 (auth checked before body validation).

### Edge Cases

- **Project from path**: the stored `project` is always the path segment; a `project` field in the body (if any) is ignored.
- **Missing `author_date`**: allowed; stored null. The read path already renders a valid `author_date` by falling back to `created_at` (the #128 read-path fix), so the response stays schema-valid.
- **`ref` vs branch**: `ref` is the branch name; the read endpoints' `branch` filter matches against it. Omitted `ref` stores null.
- **Long `message` / unusual `hash`**: stored as given; only non-emptiness of `hash` is enforced.
- **Single commit per request**: this endpoint ingests one commit; multi-commit (push-event) bulk ingestion is a future addition (out of scope).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose `POST /users/current/projects/{project}/commits` that records a commit for the authenticated user under the path `project`.
- **FR-002**: The write MUST be idempotent on `(user_id, project, hash)` — re-posting the same `hash` updates the existing row's mutable fields (`message`, `author_name`/`author_email`/`author_date`, `committer_*`, `total_seconds`, `ref`, `url`) in place rather than inserting a duplicate.
- **FR-003**: `hash` MUST be required and non-empty; otherwise 400.
- **FR-004**: `total_seconds` MUST be optional; when present it MUST be a number `>= 0` (else 400) and is stored as-is. The server MUST NOT compute it from heartbeats.
- **FR-005**: `author_date` and `committer_date` MUST be optional; when present they MUST be valid date-times (else 400) and are stored normalized so the read path renders them schema-valid.
- **FR-006**: On success the system MUST return `201` with `{ data: Commit }` in the same `Commit` shape as the read endpoints.
- **FR-007**: The endpoint MUST require authentication (Bearer API key); an unauthenticated request returns 401, checked before body validation.
- **FR-008**: The stored `project` MUST come from the path; any `project` in the body MUST be ignored.
- **FR-009**: An ingested commit MUST be immediately retrievable via the existing read endpoints (list + single), honoring their ordering and `author`/`branch` filters.
- **FR-010**: Ingestion MUST NOT alter unrelated aggregates (`summaries`, `hourly_summaries`, `user_projects`) — commits are an independent series.

### Key Entities

- **`commits`** (existing table, no schema change): `(user_id, project, hash)` is already `UNIQUE`, which backs the idempotent upsert. Columns `message, author_name, author_email, author_date, committer_name, committer_email, committer_date, total_seconds, ref, url` are populated from the body.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a `POST`, the commit is returned by `GET .../commits` and `GET .../commits/{hash}` for the same user/project.
- **SC-002**: Posting the same `hash` N times yields exactly one stored row, reflecting the latest mutable-field values.
- **SC-003**: Every malformed input (missing/blank `hash`, negative/non-numeric `total_seconds`, unparseable date) returns 400 and stores nothing.
- **SC-004**: A commit posted by user A is never visible to user B (cross-user isolation preserved).
- **SC-005**: A supplied `total_seconds` surfaces in `human_readable_total`; an omitted one yields `"0 secs"`.
