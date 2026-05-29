# Feature Specification: Commits Read Endpoints

**Feature Branch**: `107-commits`
**Created**: 2026-05-29
**Status**: Draft
**Input**: The `commits` D1 table and two OpenAPI operations (`getProjectCommits`, `getProjectCommit`) are declared, but no route is mounted and no ingestion path populates the table.

## Background

Commit endpoints attribute coding time to individual git commits ("how long did the work that produced `abc123` take"). Two read operations are declared:

- `GET /api/v1/users/current/projects/{project}/commits` — paginated list,
- `GET /api/v1/users/current/projects/{project}/commits/{hash}` — single commit.

This feature wires those two **read** endpoints to the existing `commits` table. It is **low priority** for single-user — useful but not on the core "heartbeats → today's stats" path.

## Scope decision: read path first, ingestion deferred

The declared OpenAPI surface is **read-only**. There is no ingestion path, and the issue explicitly leaves the ingestion mechanism open: a coding-time CLI/editor plugin that posts commits as they're authored, versus a server-side git webhook. That is a genuine product/integration decision with auth and source-of-truth implications, not something to settle inside a low-priority read feature.

So this feature ships the **two read endpoints only**, mirroring how Goals shipped its read path before CRUD (#95/#96). The `commits` table is populated out of band for now (operator `wrangler d1 execute`, or a future ingestion PR). Establishing the read contract + handlers now means commits are immediately queryable once an ingestion path lands.

**Out of scope (deferred to a follow-up):** `POST` create, the plugin-vs-webhook decision, and any change to heartbeat ingestion.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - List a project's commits (Priority: P3)

As an authenticated user, I want to page through my commits for a project, newest first, so I can see per-commit coding time.

**Independent Test**: Seed several `commits` rows for a project across dates. `GET …/projects/{project}/commits` returns them as `{data: Commit[], page, total_pages}` ordered by `author_date` descending, 100 per page, with `human_readable_total` derived from `total_seconds`.

**Acceptance Scenarios**:
1. **Given** commits across several dates, **When** listing, **Then** they return ordered by `author_date` descending, with `page` and `total_pages` set.
2. **Given** more than 100 commits, **When** listing `?page=2`, **Then** the second 100 return and `total_pages` reflects the count.
3. **Given** `author` / `branch` filters, **When** listing, **Then** only commits matching `author_email` / `ref` return.
4. **Given** no commits for the project, **When** listing, **Then** `{data: [], page: 1, total_pages: 0}` with 200.
5. **Given** an invalid `page` (non-integer, < 1), **When** listing, **Then** 400.
6. **Given** another user's commits for the same project name, **When** listing, **Then** none appear (strict per-user scoping).
7. **Given** an unauthenticated request, **Then** 401.

---

### User Story 2 - Inspect a single commit (Priority: P3)

As an authenticated user, I want a single commit by hash so a client can show its detail.

**Acceptance Scenarios**:
1. **Given** an owned commit, **When** requesting `…/commits/{hash}`, **Then** `{data: Commit}` with `human_readable_total`.
2. **Given** an unknown `hash`, or a hash owned by another user, **When** requesting, **Then** 404 (no existence leak).
3. **Given** a `branch` query that does not match the commit `ref`, **When** requesting, **Then** 404.
4. **Given** an unauthenticated request, **Then** 401.

---

### Edge Cases

- **`total_seconds` NULL** (commit recorded without time attribution): `total_seconds` returns 0 / omitted and `human_readable_total` is the zero string.
- **Same `hash` across two projects**: scoped by `(user_id, project, hash)` (the table's unique key); listing/single are project-scoped.
- **Duplicate project names across users**: `user_id` scoping keeps them separate.
- **Pagination past the end**: a `page` beyond `total_pages` returns `{data: []}` (not an error).
- **Author filter case**: `author_email` exact match.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `GET /api/v1/users/current/projects/{project}/commits` MUST return the user's commits for `project` as `{data: Commit[], page, total_pages}`, ordered by `author_date` descending (ties by `hash`), 100 per page.
- **FR-002**: `page` defaults to 1; an invalid `page` (non-integer or < 1) MUST return 400. A `page` beyond the last returns an empty `data` (not an error).
- **FR-003**: Optional `author` filters on `author_email` (exact); optional `branch` filters on `ref` (exact).
- **FR-004**: Each `Commit` MUST include `human_readable_total` derived from `total_seconds` (0 when NULL), reusing the shared duration formatter.
- **FR-005**: `GET /api/v1/users/current/projects/{project}/commits/{hash}` MUST return a single owned commit as `{data: Commit}`; an unknown/unowned `(project, hash)` MUST return 404 (never 403, never another user's row). If `branch` is supplied, it MUST exact-match the commit `ref`; a mismatch returns 404.
- **FR-006**: All endpoints MUST require authentication (401) and be strictly scoped by `user_id`.
- **FR-007**: This feature MUST NOT add an ingestion path or modify heartbeat ingestion; the `commits` table is read-only here.

### Non-Functional Requirements

- **NFR-001**: List MUST issue at most two indexed reads (one `COUNT` for `total_pages`, one page `SELECT`); single MUST issue one. The `commits` table is keyed by `(user_id, project, hash)`.
- **NFR-002**: No D1 schema migration; no new binding or dependency.

### Key Entities *(no schema change)*

`commits` (`id`, `user_id`, `project`, `hash`, `message`, `author_name/email/date`, `committer_name/email/date`, `total_seconds`, `ref`, `url`, `created_at`, `UNIQUE(user_id, project, hash)`, `ON DELETE CASCADE`). Response uses the existing `Commit` schema.

## Success Criteria *(mandatory)*

- **SC-001**: A seeded project's commits list newest-first with correct pagination and `human_readable_total`.
- **SC-002**: `author` / `branch` filters narrow the list correctly.
- **SC-003**: Single-commit returns the row; unknown/cross-user returns 404.
- **SC-004**: Invalid `page` → 400; unauthenticated → 401; cross-user never leaks.

## Out of Scope

- **Commit ingestion** (`POST` create, CLI-plugin vs git-webhook decision). Deferred to a follow-up issue.
- **Branch as a separate dimension** beyond the `ref` exact-match filter.
- **Diff/line-level attribution** or linking commits to specific heartbeats.
- **Pagination cursors** (offset/page only).
