# Feature Specification: Goals Read Endpoints

**Feature Branch**: `100-goals-read`
**Created**: 2026-05-17
**Status**: Draft
**Input**: OpenAPI declares `getGoals` and `getGoal` operations and a `goals` D1 table exists, but neither endpoint is implemented. This feature wires the read path.

## Background

The `goals` D1 table is part of the WakaTime-compatible domain model. A goal expresses an intent to spend at least (or at most) `target_seconds` of coding time per `delta` period, optionally filtered by language / editor / project. `getGoals` returns a flat list; `getGoal` returns a single goal augmented with `chart_data` — a series of past periods showing actual vs target vs status.

This spec covers the **read path only**. Create / update / delete endpoints are explicitly deferred to a follow-up feature so this PR keeps a tight reviewable surface area and ships chart computation correctness first.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - List my goals (Priority: P1)

As an authenticated user, I want to see the goals I've configured so that I can confirm my current commitments and choose one to inspect.

**Why this priority**: Lists are the entry point to every WakaTime UI surface that consumes goals. Without it the single-goal endpoint is unreachable through any normal client flow.

**Independent Test**: Authenticate as a user with three `goals` rows seeded (different types) and call `GET /api/v1/users/current/goals`. Verify the response contains all three goals with their static fields, ordered deterministically, and that `chart_data` is **omitted** (list view is intentionally lightweight).

**Acceptance Scenarios**:

1. **Given** a user with two enabled goals and one disabled goal, **When** they call `GET /goals`, **Then** the response contains all three goals (enabled flag exposed but no filtering at the API layer).
2. **Given** the user has no goals, **When** they call `GET /goals`, **Then** the response is `{"data": []}` with HTTP 200.
3. **Given** an unauthenticated request, **When** they call `GET /goals`, **Then** the server returns 401.
4. **Given** another user has goals, **When** the calling user requests `GET /goals`, **Then** none of the other user's goals appear (strict per-user isolation).
5. **Given** a goal whose `languages` / `editors` / `projects` columns contain JSON arrays, **When** the goal is returned, **Then** the server has decoded the JSON columns into arrays before serialising the response.

---

### User Story 2 - Inspect a single goal with progress chart (Priority: P1)

As an authenticated user, I want to drill into a specific goal and see how I've been tracking against it over the past several periods, so I can decide whether to keep, adjust, or abandon it.

**Why this priority**: The chart is the single most useful piece of information a goals UI shows. Without it the feature is functionally inert.

**Independent Test**: Seed summary rows in D1 covering the past 7 days for a user, then create a `coding` goal with `delta=day` and `target_seconds=3600`. Call `GET /goals/{goal_id}` and verify:
- `chart_data` is an array of 7 entries (today + 6 prior days).
- For each entry, `actual_seconds` matches the sum of matching summary rows for that local-timezone day.
- `range_status` is `success` when `actual_seconds >= target_seconds`, `fail` otherwise, except the most recent period which is `pending`.
- Top-level `status` equals the most recently completed period's status (the entry immediately preceding the pending one).

**Acceptance Scenarios**:

1. **Given** a `type=coding, delta=day, target_seconds=3600` goal and 7 days of summary data, **When** the user calls `GET /goals/{id}`, **Then** `chart_data` has 7 entries, indexed today-back-to-six-days-ago in chronological order.
2. **Given** a `type=languages, delta=day, languages=["TypeScript"]` goal, **When** the user calls `GET /goals/{id}`, **Then** `actual_seconds` for each period sums only summary rows whose `language='TypeScript'`.
3. **Given** a `type=editors, delta=week, editors=["VSCode"]` goal, **When** the user calls `GET /goals/{id}`, **Then** `chart_data` has 7 entries one per ISO week, each summing the user's `VSCode`-tagged summaries within that week's date range.
4. **Given** an `is_inverse=true` goal with `target_seconds=1800` and a day with `actual_seconds=600`, **When** the goal is returned, **Then** that day's `range_status` is `success` (under cap), not `fail`.
5. **Given** `is_snoozed=true`, **When** the goal is returned, **Then** the chart still reflects actuals but the top-level `status` is `pending` regardless of period outcomes — snoozing pauses status interpretation, not data collection.
6. **Given** a goal whose owner is a different user, **When** the calling user requests it, **Then** the server returns 404 (not 403, to avoid leaking goal-id existence).
7. **Given** an unknown goal ID, **When** the user requests it, **Then** the server returns 404.

---

### User Story 3 - Pending day-boundary correctness across timezones (Priority: P2)

As a user located outside UTC, I want the "today" period in my goal chart to reflect my actual local day, so the `pending` status moves with my real day boundary instead of jumping at UTC midnight.

**Why this priority**: Heartbeat summarisation already buckets by user timezone (Issue #28/#65). The goal chart must use the same convention or users will see misaligned periods.

**Acceptance Scenarios**:

1. **Given** a user with `timezone='Asia/Tokyo'`, **When** the local time is 2026-05-18 02:00 JST (still 2026-05-17 in UTC), **Then** the pending range in `chart_data` is dated 2026-05-18.
2. **Given** the spring-forward DST day in `America/New_York`, **When** the goal chart includes that date, **Then** the range still spans the local calendar day even though the underlying epoch range is 23 hours.

---

### Edge Cases

- **Empty filter arrays**: A `type=languages` goal with `languages=[]` matches nothing. Documented but not an error condition — clients should validate before persisting (CRUD spec, not this one).
- **Goal `delta` value not in the spec enum (`day` / `week`)**: Should not happen because schema constrains it, but defensively the server treats unknown values as `day`.
- **Goal `type` outside enum**: Same as above — defensively treat as `coding`.
- **Summaries gap**: If no summary rows exist for a given period, `actual_seconds` is 0 and status follows the comparison rule.
- **Snoozed + inverse**: Status is `pending` (snoozed wins).
- **Disabled goal**: Returned by the list and single endpoints unchanged. Clients decide to hide / dim disabled goals in UI. No filtering at the API layer to keep the contract straightforward.
- **`chart_data` length when goal is newer than 7 periods ago**: All 7 periods are still returned. Periods predating goal creation simply show whatever actuals exist (heartbeats predate the goal); status is computed normally. Documented to avoid confusion — the chart is "last 7 periods of activity," not "last 7 periods since goal creation."
- **Day boundary uses user's profile timezone**: Source of truth for the user's TZ is `users.timezone` (already validated and used by the cron aggregator). Fall back to UTC if the value is unparseable.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `GET /api/v1/users/current/goals` MUST return all goal rows owned by the authenticated user, in `created_at` ascending order, as `{"data": [Goal, ...]}`.
- **FR-002**: The list endpoint MUST NOT include `chart_data` on returned goals (lightweight response).
- **FR-003**: `GET /api/v1/users/current/goals/{goal_id}` MUST return a single goal owned by the user, augmented with `chart_data` and top-level `status`, as `{"data": Goal}`.
- **FR-004**: A request for a goal not owned by the user MUST return 404 (not 403 — do not leak existence).
- **FR-005**: `chart_data` MUST contain exactly 7 entries: the current period plus the 6 immediately preceding periods, in chronological order (oldest first).
- **FR-006**: For `delta=day`, each entry spans one local-calendar day in the user's profile timezone. For `delta=week`, each entry spans Monday 00:00 through Sunday 23:59 in the user's profile timezone.
- **FR-007**: `actual_seconds` per period MUST be the sum of matching `summaries.total_seconds` rows for that period. Filter semantics:
  - `type=coding`: sum across all summaries.
  - `type=languages`: only rows whose `language` is in the goal's `languages` filter.
  - `type=editors`: only rows whose `editor` is in the goal's `editors` filter.
  - `type=projects`: only rows whose `project` is in the goal's `projects` filter.
- **FR-008**: `range_status` per period MUST be `pending` for the current (incomplete) period. For completed periods, `success` if `actual_seconds >= target_seconds` (when `is_inverse=false`) or `actual_seconds <= target_seconds` (when `is_inverse=true`); `fail` otherwise.
- **FR-009**: Top-level `status` MUST equal the `range_status` of the period immediately preceding the pending one (i.e., the most recently completed period). If the goal is `is_snoozed=true`, top-level `status` MUST be `pending` regardless of period outcomes.
- **FR-010**: All endpoints MUST require API key or session authentication. Single-user mode and multi-user mode behave identically.
- **FR-011**: The list endpoint MUST emit `Cache-Control: no-store` to prevent caching of user-private data. (The `authMiddleware` already adds this header centrally; no per-route work needed.)
- **FR-012**: `languages`, `editors`, and `projects` columns are stored as JSON-encoded TEXT in D1. The handlers MUST decode them into arrays before serialising, and MUST treat invalid JSON as an empty array (with an error log).

### Non-Functional Requirements

- **NFR-001**: A single `GET /goals/{id}` request MUST complete within the Workers 10ms CPU budget on the free tier. The chart computation reads at most ~7 days of pre-aggregated `summaries` rows; no heartbeat scan.
- **NFR-002**: The list endpoint MUST issue at most one D1 query (single SELECT against `goals`).
- **NFR-003**: The single-goal endpoint MUST issue at most two D1 queries: one for the goal row, one batched read of the 7-period summary aggregates.

### Key Entities *(no schema change)*

No schema changes. Existing columns on `goals` cover everything; existing `summaries` rows are the data source for `actual_seconds`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An authenticated user with three goals receives a list with three entries in stable order.
- **SC-002**: A single-goal request returns `chart_data` of length 7 with chronologically ordered periods.
- **SC-003**: Chart actuals reproduce the user's known summary totals for each period (verifiable by comparing to a direct `summaries` SELECT).
- **SC-004**: Status computation passes all rules in FR-008 (covered by acceptance scenarios 1-5 of User Story 2).
- **SC-005**: Cross-user requests return 404, never 200 or 403.
- **SC-006**: New code under `src/routes/goals.ts` is ≤ 200 LoC and uses only the project's existing D1 helpers and `time-format` utilities.

## Out of Scope

- **POST / PATCH / DELETE** on goals. A separate spec will add CRUD, after the read shape is established and reviewed.
- **Notification or reminder** of pending / failed goals. Email or push surfaces are out of scope; the chart is the only feedback surface.
- **Goal templates / suggestions**. CloudTime does not propose goals based on activity.
- **History longer than 7 periods**. Trends beyond a week of data are deferred to future analytics endpoints.
- **Aggregating multiple goals**. Each goal is independent; there is no compound "today's overall status" derived from multiple goals.
- **Soft-deleted goals / archive view**. `is_enabled=false` keeps the goal visible; archiving is part of the CRUD spec (delete vs disable).
