# Feature Specification: Timezone-Aware Summary Bucketing

**Feature Branch**: `065-timezone-bucketing`
**Created**: 2026-03-13
**Status**: Draft
**Input**: GitHub Issues #28, #29 — Fix UTC-only summary bucketing and harden global stats timezone handling

## Clarifications

### Session 2026-03-13

- Q: Should the `timezone` query parameter on authenticated endpoints default to the user's profile timezone instead of UTC? → A: Yes — authenticated endpoints default to profile timezone; unauthenticated (global stats) remains UTC.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Accurate daily summaries in my local timezone (Priority: P1)

As a developer using CloudTime from a non-UTC timezone (e.g., Asia/Tokyo, UTC+9), I want my daily coding summaries to reflect my actual local day, so that "Today" and "Yesterday" show the correct hours of work.

Although the cron aggregation already buckets summaries by the user's profile timezone, the query endpoints currently default the `timezone` parameter to UTC when omitted. A developer in Tokyo who queries `/summaries?range=Today` without specifying `?timezone=Asia/Tokyo` gets a date range anchored to UTC — misaligning with the JST-bucketed data. This causes off-by-one-day errors for single-day queries like "Today" or "Yesterday."

**Why this priority**: This is the core problem reported in Issue #28. Without timezone-aware bucketing, single-day summary queries return incorrect data for any user outside UTC. This directly undermines the primary value of the product — accurate time tracking.

**Independent Test**: Can be fully tested by setting a user's timezone to a non-UTC value (e.g., Asia/Tokyo), ingesting heartbeats that span a UTC day boundary, running the aggregation, and verifying that the resulting summary dates align with the user's local day.

**Acceptance Scenarios**:

1. **Given** a user with timezone set to "Asia/Tokyo" and heartbeats at 2026-03-14 01:00 JST (2026-03-13 16:00 UTC), **When** the cron aggregation runs, **Then** the summary row is bucketed under date "2026-03-14" (the user's local date).
2. **Given** a user with timezone set to "America/New_York" and heartbeats at 2026-03-13 23:00 EST (2026-03-14 04:00 UTC), **When** the cron aggregation runs, **Then** the summary row is bucketed under date "2026-03-13" (the user's local date).
3. **Given** a user with timezone set to "UTC" (default), **When** the cron aggregation runs, **Then** behavior is identical to the current UTC bucketing — no regression.
4. **Given** a user changes their timezone from UTC to Asia/Tokyo, **When** the next cron aggregation runs, **Then** only newly ingested heartbeats are bucketed using the updated timezone. Previously aggregated summaries remain unchanged.

---

### User Story 2 - Set my timezone in my profile (Priority: P1)

As a user, I want to set my preferred timezone in my profile so that all time-related features use my local time.

The `users.timezone` column already exists (default: 'UTC'). The user profile update endpoint already supports setting a timezone field. This story ensures the timezone value is validated and persisted correctly, and that the cron aggregation reads it.

**Why this priority**: Without a valid, persisted timezone, Story 1 cannot function. This is a prerequisite.

**Independent Test**: Can be tested by updating a user's profile with a valid IANA timezone string and verifying it is persisted, then attempting an invalid timezone and verifying it is rejected.

**Acceptance Scenarios**:

1. **Given** a user updates their profile with timezone "Asia/Tokyo", **When** the profile is saved, **Then** the timezone is persisted and returned in subsequent profile queries.
2. **Given** a user updates their profile with an invalid timezone "Mars/Olympus", **When** the profile is saved, **Then** the system rejects the update with a validation error.
3. **Given** a new user is created, **When** no timezone is specified, **Then** the timezone defaults to "UTC".

---

### User Story 3 - Document global stats timezone limitation (Priority: P2)

As a project maintainer, I want to clearly document that the global stats endpoint uses the requesting user's timezone parameter only for date range anchoring — not for re-bucketing summary data — and that in future multi-user mode, cross-user timezone aggregation will have known limitations.

This addresses Issue #29 by documenting the current behavior rather than implementing a complex fix that is only needed for multi-user mode (Milestone 4).

**Why this priority**: This is lower priority because the global stats endpoint's timezone behavior is acceptable for single-user mode. Documenting the limitation prevents confusion and sets expectations for future multi-user support.

**Independent Test**: Can be tested by verifying the documentation exists and accurately describes the behavior: global stats uses summary rows as-is (bucketed by the user's profile timezone) and the query `timezone` parameter only shifts the date range anchor.

**Acceptance Scenarios**:

1. **Given** the global stats endpoint documentation, **When** a developer reads it, **Then** they understand that summary data is bucketed by the owner's profile timezone, not the requesting client's timezone parameter.
2. **Given** the global stats endpoint in single-user mode, **When** queried with any timezone parameter, **Then** behavior is correct because there is only one user whose profile timezone matches the bucketing.

---

### Edge Cases

- What happens when a user's timezone observes daylight saving time (DST)? The day boundary shifts by one hour. Heartbeats near the DST transition must be bucketed using the correct offset at the time of the heartbeat, not the current offset.
- What happens when a heartbeat's `time` field is in the future (clock skew)? The system should still bucket it by the computed local date — no special handling needed beyond what already exists.
- What happens when the cron runs during a timezone's day boundary (e.g., midnight in JST)? The aggregation uses each heartbeat's individual timestamp to determine its local date — the cron execution time is irrelevant.
- What happens when no heartbeats exist for a given local date? No summary row is created for that date (current behavior, unchanged).
- What happens when there are previously aggregated UTC-bucketed summaries and the user sets a non-UTC timezone? Old summaries remain with their original UTC dates. Only new heartbeats (after the timezone change) are bucketed using the new timezone. A migration strategy for historical data is out of scope.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The cron aggregation MUST bucket heartbeats into summary rows using the user's profile timezone (from the `users.timezone` column) to determine the local date for each heartbeat.
- **FR-002**: The system MUST validate timezone values against the IANA Time Zone Database (e.g., "Asia/Tokyo", "America/New_York", "UTC") when updating a user's profile.
- **FR-003**: The system MUST default to "UTC" when no timezone is set for a user.
- **FR-004**: The cron aggregation MUST handle daylight saving time transitions correctly by computing the local date for each heartbeat based on the offset in effect at the heartbeat's timestamp.
- **FR-005**: The cron aggregation MUST remain incremental — only processing heartbeats newer than the last aggregation timestamp.
- **FR-006**: The global stats endpoint documentation MUST describe the timezone behavior: summary data is bucketed by the owner's profile timezone; the query `timezone` parameter only shifts the date range anchor.
- **FR-007**: Previously aggregated summary rows MUST NOT be re-bucketed when a user changes their timezone. Only new heartbeats are affected.
- **FR-008**: The cron aggregation MUST complete within the Cloudflare Workers CPU time budget (10ms per invocation on free tier, with Cron Triggers allowing up to 30s on paid).
- **FR-009**: Authenticated endpoints that accept a `timezone` query parameter MUST default to the user's profile timezone when the parameter is omitted. Unauthenticated endpoints (e.g., global stats) MUST continue to default to UTC. The additional data lookup to resolve the user's timezone MUST NOT cause request handlers to exceed the Cloudflare Workers 10ms CPU budget.

### Key Entities

- **User Profile**: Contains the user's preferred IANA timezone string (e.g., "Asia/Tokyo"). Used by the cron aggregation to determine local dates.
- **Heartbeat**: Raw coding activity event with a UNIX epoch timestamp (`time` field). The timestamp is always in UTC (epoch is timezone-agnostic).
- **Summary**: Aggregated daily coding statistics. The `date` field represents a calendar date in the user's local timezone at the time of aggregation.
- **Global Stats**: Public aggregate statistics. In single-user mode, uses the single user's timezone-bucketed summaries. Multi-user aggregation is deferred to Milestone 4.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For a user in any IANA timezone, "Today" summary queries return data that matches the user's local calendar date with 100% accuracy (no off-by-one-day errors at UTC day boundaries).
- **SC-002**: Summary data for single-day queries ("Today", "Yesterday") aligns with the user's local day, verified across at least 3 representative timezones (UTC, UTC+9, UTC-5).
- **SC-003**: Invalid timezone strings are rejected at the profile update endpoint with a clear error message, preventing data corruption.
- **SC-004**: The cron aggregation processes heartbeats within the Cloudflare Workers time budget without timeouts or errors.
- **SC-005**: Users who do not set a timezone experience no change in behavior (backward compatibility with UTC default).
- **SC-006**: Authenticated API queries without an explicit `timezone` parameter return results aligned with the user's profile timezone — no client-side timezone specification required for correct results.
