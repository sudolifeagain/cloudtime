# Feature Specification: Apply the `weekday` filter to the `days` insight type

**Feature Branch**: `133-insights-weekday-filter`
**Created**: 2026-06-04
**Status**: Draft
**Input**: The `getInsight` operation already accepts a `weekday` query parameter, but it is declared "accepted but not applied in the first cut" (`schemas/paths/insights/insights.yaml`). Clients can pass `weekday=monday` / `weekday=0`, but it has no effect — the full `days[]` series is always returned. Issue #133.

## Background

The Insights endpoint (`GET /api/v1/users/current/insights/{insight_type}/{range}`, shipped in #103) derives an insight from the pre-aggregated `summaries` table. The `days` insight type returns `days[]` — one entry per active date in the range, each `{date, total_seconds, text}`.

WakaTime-compatible clients expose a "filter by day of week" control on the days view (e.g. "show only my Mondays"). The contract already reserves a `weekday` query parameter for this, but the first cut accepts it without applying it. This feature graduates `weekday` from *reserved* to *applied* for the `days` insight type only.

No new table, no raw-heartbeat scan, no schema migration: the filter is a pure post-grouping restriction of the per-date totals the endpoint already computes. The weekday of each date is derived exactly as the existing `weekday` insight already derives it (0=Sunday … 6=Saturday), so the two insight types stay internally consistent.

The sibling `timeout` and `writes_only` query parameters remain reserved/unapplied and are **out of scope** here.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Filter the days view to a single weekday (Priority: P1)

As an authenticated user looking at my per-day coding totals, I want to restrict the `days` insight to a single day of the week so I can compare, say, all my Mondays over the range.

**Why this priority**: This is the entire feature. Without it the parameter is inert.

**Independent Test**: Seed `summaries` across dates spanning multiple weeks. `GET /insights/days/last_30_days?weekday=monday` returns `{data:{type:"days", days:[…]}}` where every entry's `date` falls on a Monday (in the user's profile timezone), and no non-Monday dates appear.

**Acceptance Scenarios**:

1. **Given** summaries on dates that fall on several different weekdays, **When** requesting `days` with `weekday=monday`, **Then** `days[]` contains only the dates that are Mondays, still ordered ascending by date, each `{date, total_seconds, text}` unchanged.
2. **Given** the same data, **When** requesting `days` with `weekday=1`, **Then** the result is identical to `weekday=monday` (1 = Monday under the 0=Sunday convention).
3. **Given** the same data, **When** requesting `days` with `weekday=MONDAY` (any letter case), **Then** the result is identical to `weekday=monday`.
4. **Given** summaries with no activity on the requested weekday in range, **When** requesting `days` with that `weekday`, **Then** `days` is `[]` with HTTP 200.
5. **Given** the `weekday` parameter is omitted, **When** requesting `days`, **Then** the full unfiltered `days[]` is returned (unchanged behavior).

---

### User Story 2 - Invalid weekday values are rejected (Priority: P2)

As an API client author, I want a clear error when I pass a malformed `weekday` so I can fix my request rather than silently receive unfiltered data.

**Why this priority**: Prevents silent contract violations; small but important for compatibility correctness.

**Independent Test**: `GET /insights/days/last_30_days?weekday=funday` returns HTTP 400 with an error message; `?weekday=7` and `?weekday=-1` also return 400.

**Acceptance Scenarios**:

1. **Given** an unrecognised weekday name, **When** requesting `days` with `weekday=funday`, **Then** HTTP 400.
2. **Given** an out-of-range integer, **When** requesting `days` with `weekday=7` (or `-1`), **Then** HTTP 400.
3. **Given** an empty value, **When** requesting `days` with `weekday=` (present but blank), **Then** HTTP 400 (a present-but-unparseable value is an error, distinct from omission).

---

### User Story 3 - `weekday` is ignored by non-`days` insight types (Priority: P3)

As a client that attaches `weekday` to every insights request, I want non-`days` insight types to keep working unchanged so I don't have to special-case my query building.

**Why this priority**: Preserves forward-compatibility for clients already sending the (previously inert) parameter.

**Independent Test**: `GET /insights/languages/last_30_days?weekday=monday` returns the same payload as without the parameter.

**Acceptance Scenarios**:

1. **Given** any non-`days` insight type (`languages`, `weekday`, `best_day`, …), **When** a `weekday` query value is present, **Then** it is ignored and the response is identical to the request without it.
2. **Given** a non-`days` insight type with a syntactically **invalid** `weekday` (e.g. `weekday=funday`), **When** requested, **Then** the value is ignored and 200 is returned (validation applies only where the value is used — see FR-007).

### Edge Cases

- **Timezone**: the weekday is computed from the date as already bucketed into the user's profile timezone by aggregation (the same basis as the existing `weekday` insight). No additional timezone conversion is introduced.
- **All-time / yearly ranges**: filtering composes with any `range`; it operates on whatever dates the range produced.
- **Numeric vs name equivalence**: `0`==`sunday`, `1`==`monday`, … `6`==`saturday`.
- **Leading/trailing whitespace** in the value: trimmed before parsing (e.g. `weekday=%20monday` → `monday`).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST apply the `weekday` query parameter as a filter on the `days` insight type, returning only the per-date entries whose date falls on the requested day of the week.
- **FR-002**: The system MUST accept `weekday` as an integer `0`–`6` where **0=Sunday, 1=Monday, … 6=Saturday**, matching the convention used by the existing `weekday` insight.
- **FR-003**: The system MUST accept `weekday` as a case-insensitive full English weekday name (`sunday`, `monday`, `tuesday`, `wednesday`, `thursday`, `friday`, `saturday`), equivalent to the corresponding integer.
- **FR-004**: The system MUST preserve the existing `days[]` ordering (ascending by date) and per-entry shape (`date`, `total_seconds`, `text`) after filtering.
- **FR-005**: When `weekday` is omitted, the system MUST return the full unfiltered `days[]` (no behavior change).
- **FR-006**: For the `days` insight type, the system MUST return HTTP 400 when `weekday` is present but is neither a valid integer `0`–`6` nor a recognised weekday name.
- **FR-007**: For insight types other than `days`, the system MUST ignore the `weekday` parameter (including syntactically invalid values) and return the same response as if it were absent.
- **FR-008**: The system MUST compute each date's weekday on the same basis as the existing `weekday` insight (user-profile-timezone date as bucketed in `summaries`), so `days` filtering and the `weekday` insight agree on which dates are e.g. Mondays.
- **FR-009**: The `timeout` and `writes_only` query parameters MUST remain accepted-but-unapplied (no change); only `weekday` graduates to applied.

### Key Entities

- No new entities. Operates on the existing `summaries` per-date totals already produced by the endpoint.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A `days` request with `weekday=monday` returns 100% Monday-dated entries and 0% other-weekday entries for any seeded dataset.
- **SC-002**: `weekday=<n>` and `weekday=<name>` produce byte-identical responses for every equivalent pair (0/sunday … 6/saturday).
- **SC-003**: Every malformed `weekday` on a `days` request yields HTTP 400; no malformed value ever returns partial or unfiltered data as if valid.
- **SC-004**: Non-`days` insight responses are unchanged whether or not `weekday` is present (regression-free for existing clients).
- **SC-005**: No new D1 table, no schema migration, and request latency stays within the existing single-`GROUP BY` budget (filtering is in-memory, O(active days)).
