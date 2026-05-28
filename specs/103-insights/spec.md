# Feature Specification: Insights Endpoint

**Feature Branch**: `103-insights`
**Created**: 2026-05-29
**Status**: Draft
**Input**: The `getInsight` OpenAPI operation is declared (`/users/current/insights/{insight_type}/{range}`) but has no route or computation. Insights (best day, productive weekday, language trends) are a highly visible end-user feature and are currently absent.

## Background

Insights summarise a user's coding activity along a chosen dimension over a chosen time range. Everything in the first cut is derivable from the pre-aggregated `summaries` table (per user / date / project / language / editor / operating_system / category / machine), so no new table or raw-heartbeat scan is needed.

The declared `insight_type` enum is: `weekday`, `days`, `best_day`, `daily_average`, `projects`, `languages`, `editors`, `categories`, `machines`, `operating_systems`. An `hours`-of-day insight is **not** declared and is out of scope (it needs hour granularity that `summaries` does not carry).

`range` reuses the `GET /stats/{range}` vocabulary via the existing `resolveStatsRange` helper: `last_7_days`, `last_30_days`, `last_6_months`, `last_year`, `all_time`, `YYYY`, `YYYY-MM`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Dimension insights (Priority: P1)

As an authenticated user, I want to see my top languages / editors / projects / categories / machines / operating systems over a range so I understand where my time goes.

**Independent Test**: Seed `summaries` across a few dates with two languages. `GET /insights/languages/last_7_days` returns `{data:{type:"languages", range:{…}, items:[…]}}` where `items` are the languages ordered by `total_seconds` desc, each with `percent` of the range total.

**Acceptance Scenarios**:
1. **Given** summaries with several languages, **When** requesting `languages`, **Then** `items` lists each language once with summed `total_seconds`, `percent` of the range total, and human `text`/`digital`, ordered most-time-first.
2. **Given** the same data, **When** requesting `editors` / `projects` / `categories` / `machines` / `operating_systems`, **Then** `items` groups by that column equivalently.
3. **Given** rows whose dimension column is NULL, **When** grouping, **Then** they are bucketed under a stable `"Unknown"` name (not dropped).
4. **Given** no summaries in range, **When** requesting any dimension insight, **Then** `items` is `[]` with HTTP 200.
5. **Given** an unauthenticated request, **Then** 401.

---

### User Story 2 - Temporal insights (Priority: P1)

As an authenticated user, I want day-level views — total per day, my best day, my daily average, and which weekday I code most — to understand my rhythm.

**Independent Test**: Seed summaries on known dates. `GET /insights/best_day/last_30_days` returns the single highest-total day in `best_day`; `daily_average` returns mean seconds per active day; `days` returns per-day totals; `weekday` returns a per-weekday average.

**Acceptance Scenarios**:
1. **Given** summaries across several dates, **When** requesting `days`, **Then** `days[]` lists active dates ascending, each `{date, total_seconds, text}`.
2. **Given** the same data, **When** requesting `best_day`, **Then** `best_day` is the date with the greatest summed `total_seconds`.
3. **Given** the same data, **When** requesting `daily_average`, **Then** `daily_average.seconds` is the total divided by the number of **active** days in range (days with any summary row).
4. **Given** the same data, **When** requesting `weekday`, **Then** `items[]` has one entry per weekday that occurred (`name` = Monday…Sunday), `total_seconds` = mean of that weekday's active-day totals, ordered most-active-first.
5. **Given** no summaries in range, **When** requesting `best_day` / `daily_average`, **Then** the field is present with zeroed values (`total_seconds`/`seconds` = 0), and `days` / `weekday items` are empty.

---

### Edge Cases

- **Invalid `insight_type`** (not in the enum): 400.
- **Invalid `range`** (unparseable): 400 (mirrors `/stats`).
- **`all_time` range**: `resolveStatsRange` maps it to `1970-01-01…today`. `daily_average` divides by **active** days (not calendar days) so the average is not diluted to near-zero.
- **`YYYY` / `YYYY-MM` ranges**: scoped to that calendar year / month in the user's timezone.
- **NULL dimension values**: bucketed under `"Unknown"`.
- **Single active day**: `daily_average` equals that day's total; `weekday` has one item.
- **Percent with zero total**: `percent` is 0 for every item (no divide-by-zero).
- **Timezone**: `summaries.date` is already bucketed in the user's profile timezone by the cron aggregator; insights group by that `date` string directly. Weekday is derived from the local `date`.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `GET /api/v1/users/current/insights/{insight_type}/{range}` MUST validate `insight_type` against the declared enum and resolve `range` via `resolveStatsRange`; an invalid value of either returns 400.
- **FR-002**: All computation MUST read only from `summaries` (rows `WHERE user_id = ? AND date BETWEEN start AND end`); no raw `heartbeats` scan, no new table.
- **FR-003**: Dimension insights (`projects`, `languages`, `editors`, `categories`, `machines`, `operating_systems`) MUST return `items[]` grouped by that column, summed `total_seconds`, ordered descending, each with `percent` = share of the range total (0 when total is 0), plus `digital`/`text`/`hours`/`minutes`/`seconds` formatting. NULL values bucket under `"Unknown"`.
- **FR-004**: `days` MUST return `days[]` of active dates ascending, each `{date, total_seconds, text}`.
- **FR-005**: `best_day` MUST return the active date with the greatest summed `total_seconds` (ties → earliest date); zeroed when no activity.
- **FR-006**: `daily_average` MUST return `{seconds, text}` where `seconds` = range total ÷ number of active days (0 when none).
- **FR-007**: `weekday` MUST return `items[]` with one entry per occurring weekday (`name` = English weekday), `total_seconds` = mean of that weekday's active-day totals, ordered descending.
- **FR-008**: The response MUST set `data.type` to the requested `insight_type` and `data.range` to the resolved `TimeRange` (`start`, `end`, `text`, `timezone`).
- **FR-009**: Results MUST be strictly scoped by `user_id`; unauthenticated requests return 401.
- **FR-010**: `timeout` and `writes_only` query parameters MUST be accepted without error but are not applied in the first cut (documented limitation).

### Non-Functional Requirements

- **NFR-001**: Each request MUST stay within the Workers 10ms CPU budget — one indexed `SELECT … GROUP BY` over the `summaries` date window, plus in-memory shaping. No per-item extra query.
- **NFR-002**: No D1 schema migration; no new binding; no new dependency.
- **NFR-003**: The handler MUST reuse the existing range resolver and the shared duration-formatting helpers used by `/stats` (`digital`/`text` formatting), not reimplement them.

### Key Entities *(no schema change)*

`summaries` is the only data source. The existing unique index on `(user_id, date, project, language, editor, operating_system, category, branch, machine)` supports grouped reads. The response uses the existing `Insight`, `SummaryItem`, and `TimeRange` schemas.

## Success Criteria *(mandatory)*

- **SC-001**: Every declared `insight_type` returns a populated, correctly-shaped response against a seeded `summaries` fixture.
- **SC-002**: Dimension `percent` values sum to ~100% (within rounding) and items are ordered by time desc.
- **SC-003**: `best_day` / `daily_average` / `weekday` match hand-computed expectations on a fixed fixture.
- **SC-004**: Invalid `insight_type` and `range` both return 400; cross-user requests never leak another user's activity.
- **SC-005**: A single `summaries` SELECT backs each request (verified by handler review / no N+1).

## Out of Scope

- **`hours`-of-day insight.** Needs hour granularity; would require an hourly aggregate (extend cron) or a raw-heartbeat scan. Deferred to a follow-up; explicitly not in the declared enum.
- **Applying `timeout` / `writes_only`.** Summaries already bake in the session timeout and drop the write flag; honouring these would require raw heartbeats. Reserved.
- **New aggregate tables** or schema changes.
- **Caching.** May be layered later (like `/stats`); not required for correctness.
- **Custom / arbitrary ranges** beyond the `resolveStatsRange` vocabulary.
