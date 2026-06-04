# Feature Specification: Add the `hours`-of-day insight type

**Feature Branch**: `134-insights-hours-of-day`
**Created**: 2026-06-05
**Status**: Draft
**Input**: The `getInsight` operation documents that an `hours`-of-day insight is "intentionally absent because `summaries` has day granularity only" (`schemas/paths/insights/insights.yaml`). `hours` is not in the `insight_type` enum, so a request for it returns 400. Issue #134.

## Background

The Insights endpoint (`GET /api/v1/users/current/insights/{insight_type}/{range}`, shipped in #103) derives an insight from the pre-aggregated `summaries` table. `summaries` is bucketed at **day** granularity, so it cannot answer "how is my coding distributed across the hours of a typical day?". That hour-of-day breakdown was deferred at first cut precisely because the data was not aggregated at that resolution.

This feature adds the `hours`-of-day insight. It reports, for each hour `0–23` (computed in the user's profile timezone), the **mean coding time in that hour across the active days in the range** — the shape of a typical coding day.

To answer it within the Workers CPU budget without scanning raw heartbeats at query time, this feature introduces a second pre-aggregate, `hourly_summaries`, maintained by the **same hourly cron pass** that already maintains `summaries`, off the **same `last_aggregated_at` cursor**. The hour is bucketed in the user's timezone at aggregation time, exactly as the daily `date` already is, so the two aggregates stay internally consistent.

The sibling `timeout` and `writes_only` query parameters remain reserved/unapplied and are **out of scope** here, as is the `weekday` filter (it applies only to the `days` type, #133).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See the shape of a typical coding day (Priority: P1)

As an authenticated user, I want to see how my coding time is distributed across the hours of the day so I can understand when I am most active.

**Why this priority**: This is the entire feature. Without it the hour-of-day breakdown does not exist.

**Independent Test**: Seed `hourly_summaries` for a user across several dates with activity in known hours. `GET /insights/hours/last_30_days` returns `{data:{type:"hours", hours:[…]}}` with exactly 24 buckets, one per hour `0–23` in ascending order, each bucket's `total_seconds` equal to that hour's summed seconds divided by the number of distinct active days in the range.

**Acceptance Scenarios**:

1. **Given** activity bucketed into a few hours across multiple dates, **When** requesting `hours` for a range covering them, **Then** `hours[]` has 24 entries ordered `0…23`, hours with no activity have `total_seconds = 0`, and each active hour's `total_seconds` is its summed seconds across the range divided by the count of distinct active days.
2. **Given** the same data, **When** summing `total_seconds` across all 24 buckets, **Then** the total equals the `daily_average` insight's `seconds` for the same range (both divide the same grand total by the same active-day count).
3. **Given** a range with no activity, **When** requesting `hours`, **Then** `hours[]` still has 24 entries, all with `total_seconds = 0`, HTTP 200.
4. **Given** a user whose profile timezone differs from UTC, **When** requesting `hours`, **Then** each bucket reflects the hour as bucketed in that timezone at aggregation time (the same basis as `summaries.date`).

---

### User Story 2 - `hours` is a first-class `insight_type` (Priority: P2)

As an API client author, I want `hours` accepted by the same operation, range vocabulary, and error contract as every other insight type so I do not have to special-case it.

**Why this priority**: Consistency with the existing insights contract; small but required for a clean client experience.

**Independent Test**: `GET /insights/hours/last_7_days` and `GET /insights/hours/2026-05` both return 200 with `type:"hours"`; `GET /insights/hours/not_a_range` returns 400; an unauthenticated request returns 401.

**Acceptance Scenarios**:

1. **Given** a valid range name or `YYYY` / `YYYY-MM`, **When** requesting `hours`, **Then** HTTP 200 with `data.type === "hours"` and `data.range` populated as for every other insight type.
2. **Given** an unrecognised range, **When** requesting `hours`, **Then** HTTP 400 (same as other types).
3. **Given** no/invalid credentials, **When** requesting `hours`, **Then** HTTP 401.

---

### Edge Cases

- **Range with no data**: a stable 24-bucket response with all zeros (not an empty array), so clients can render a 24-bar profile unconditionally.
- **Duration spanning an hour boundary**: a duration interval is attributed entirely to the hour of its starting heartbeat — the same approximation aggregation already uses for the `date` bucket. The interval is at most one session timeout (≤ 60 min), so the displacement is bounded.
- **Timezone changes after the fact**: hour buckets reflect the timezone in effect at aggregation time and are not retroactively re-bucketed if the user later changes timezone — identical to the existing behavior of `summaries.date`.
- **Forward-only population**: `hourly_summaries` is filled by the cron going forward from the moment the table exists; activity already aggregated into `summaries` before that is not present unless a backfill is run (see research D-6). The contract is correct for all data aggregated on or after introduction.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST add `hours` to the `insight_type` enum so `GET /insights/hours/{range}` is a valid request.
- **FR-002**: The `hours` insight MUST return a `hours[]` array of exactly 24 entries, one per hour `0–23`, ordered ascending by `hour`, regardless of how many hours had activity.
- **FR-003**: Each `hours[]` entry MUST contain `hour` (integer `0–23`), `total_seconds` (number), and `text` (human-readable formatting of `total_seconds`).
- **FR-004**: `total_seconds` for hour *h* MUST equal the sum of seconds bucketed to hour *h* across the range divided by the number of distinct active days (dates with any activity) in the range; when there are no active days it MUST be `0`.
- **FR-005**: The hour of each duration MUST be computed in the user's profile timezone, on the same basis aggregation uses for the daily `date` (FR-009), so the two aggregates agree.
- **FR-006**: The system MUST serve the `hours` insight from a pre-aggregate (`hourly_summaries`) — it MUST NOT scan raw `heartbeats` at request time.
- **FR-007**: The `hours` insight MUST accept the same `range` vocabulary (`last_7_days`, `last_30_days`, `last_6_months`, `last_year`, `all_time`, `YYYY`, `YYYY-MM`) and return 400 for an unrecognised range and 401 when unauthenticated, identical to the other insight types.
- **FR-008**: The system MUST populate `hourly_summaries` in the same hourly cron pass and off the same `last_aggregated_at` cursor as `summaries`, so a single heartbeat scan feeds both aggregates and they advance together.
- **FR-009**: A duration interval MUST be attributed entirely to the hour-of-day of its starting heartbeat (matching how aggregation attributes the interval to that heartbeat's `date`).
- **FR-010**: The `timeout`, `writes_only`, and `weekday` query parameters MUST behave unchanged for the `hours` type — ignored, as they are for every type other than `days` (`weekday`) / every type (`timeout`, `writes_only`).

### Key Entities

- **`hourly_summaries`** (new): hour-of-day pre-aggregate. One row per (`user_id`, local `date`, local `hour` `0–23`) with an accumulating `total_seconds`. Maintained by the hourly cron; read by the `hours` insight. See `data-model.md`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A `hours` request always returns exactly 24 buckets ordered `0…23`, for any dataset including an empty range.
- **SC-002**: For any seeded dataset, the sum of all 24 buckets' `total_seconds` equals the `daily_average` insight's `seconds` for the same range (to within rounding).
- **SC-003**: For any seeded dataset, each bucket's `total_seconds` equals (summed seconds in that hour) / (distinct active days), verifiable against the seed.
- **SC-004**: A `hours` request issues no query against the `heartbeats` table (served entirely from `hourly_summaries`), staying within the existing single-aggregate-read CPU budget.
- **SC-005**: The hourly aggregation runs in the same cron invocation as the daily aggregation with no additional heartbeat scan, and both aggregates reflect the same `last_aggregated_at` cursor after a run.
