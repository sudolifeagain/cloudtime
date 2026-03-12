# Timezone Behavior

This document describes how CloudTime handles timezones for summary bucketing, query parameters, and known limitations.

## Authenticated Endpoints

All authenticated endpoints (`/summaries`, `/stats/:range`, `/status_bar/today`, `/all_time_since_today`, `/durations`) accept an optional `timezone` query parameter (IANA format, e.g. `Asia/Tokyo`).

When the `timezone` query parameter is omitted, it defaults to the authenticated user's **profile timezone** (set via `PATCH /api/v1/users/current/profile`). If the user has not set a timezone, it defaults to `UTC`.

This means "Today" and "Yesterday" ranges align with the user's local calendar date automatically.

## Global Stats

The `GET /api/v1/stats/global` endpoint is unauthenticated and defaults to `UTC` when no `timezone` parameter is provided. It does not have access to a user profile.

Summary data queried by global stats is bucketed by each user's profile timezone at cron aggregation time. In multi-user mode, this means the `summaries.date` column contains timezone-local dates from potentially different timezones. Cross-user timezone aggregation is a known limitation deferred to Milestone 4 (multi-user support).

## Cron Bucketing

The cron aggregation job (`src/cron/aggregate.ts`) buckets heartbeats into daily summaries using the user's profile timezone. This means a heartbeat at `2025-01-15 02:00 UTC` is bucketed as `2025-01-15` for a UTC user, but as `2025-01-15` (11:00 JST) for an `Asia/Tokyo` user.

This approach ensures that summary rows reflect the user's local calendar date.

## DST Handling

Day boundaries are computed using `Intl.DateTimeFormat` with the user's IANA timezone. This correctly handles Daylight Saving Time transitions — days may be 23 or 25 hours long depending on the DST shift.

## Changing Your Timezone

Changing your profile timezone affects **future** cron aggregation runs only. Previously aggregated summary rows retain their original date bucketing. Historical summaries are **not** re-bucketed.

If you change your timezone, there may be a brief period where the most recent day's summary has mixed bucketing (partially bucketed under the old timezone, partially under the new one).

## References

- Issue #28: Summaries UTC bucketing problem
- Issue #29: Global stats timezone concerns (deferred to Milestone 4)
