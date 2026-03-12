# Research: Timezone-Aware Summary Bucketing

## Key Finding: Cron Aggregation Already Timezone-Aware

**Decision**: No changes needed to cron aggregation logic.

**Rationale**: `src/cron/aggregate.ts` already:
1. Fetches user settings including timezone (`getUserSettings()` → queries `users.timezone`)
2. Uses `getDateForTimestamp(prev.time, tz)` to convert epoch → local date for bucketing
3. Handles DST correctly via `Intl.DateTimeFormat` (in `src/utils/time-format.ts`)

**Alternatives considered**: None — the existing implementation is correct.

## Key Finding: Timezone Validation Already Exists

**Decision**: No changes needed to profile validation.

**Rationale**: `src/routes/users.ts` `validateProfileInput()` already validates timezone using `Intl.DateTimeFormat(undefined, { timeZone: body.timezone })`, which validates against the runtime's IANA database.

**Alternatives considered**: None — the existing validation is correct.

## Research: How to Thread User Timezone into Authenticated Endpoints

**Decision**: Fetch user timezone in `authMiddleware` and expose it via Hono context (`c.get("userTimezone")`).

**Rationale**:
- `authMiddleware` already queries the DB for user validation (API key → user_id lookup)
- Adding `timezone` to the same query avoids an extra D1 round-trip
- All 4 affected endpoints already use `authMiddleware`, so the timezone is available without per-route changes
- Current auth flow: API key → KV cache check → D1 query if cache miss → set `c.set("userId", ...)`
- Enhancement: also set `c.set("userTimezone", ...)` from the same query/cache

**Alternatives considered**:
1. **Per-route DB query**: Each endpoint fetches timezone separately → rejected (wasteful, 4 duplicate queries)
2. **KV-only cache**: Store timezone in KV alongside auth cache → this is what the current auth cache already does, just needs to include timezone in the cached value

## Research: OpenAPI Schema Default Description

**Decision**: Update `timezone` parameter descriptions on authenticated endpoints to state "Defaults to the authenticated user's profile timezone when omitted."

**Rationale**: SDD requires spec-first changes. The OpenAPI description change documents the behavior before implementation.

**Alternatives considered**: Using OpenAPI `default` field → rejected (the default is dynamic per-user, not a static value).

## Research: Durations Endpoint Date Handling

**Decision**: The `/durations` endpoint uses a `date` query parameter (explicit YYYY-MM-DD), not a timezone-shifted range. The timezone affects only how the date maps to epoch boundaries. Currently it uses UTC boundaries. With FR-009, it should use the user's profile timezone to determine epoch boundaries for the given date.

**Rationale**: A user in Asia/Tokyo requesting `?date=2026-03-14` expects data from 2026-03-14 00:00 JST to 2026-03-14 23:59 JST, not UTC boundaries.

**Alternatives considered**: Leave as UTC → rejected (same off-by-one issue as summaries).

## Research: Global Stats Documentation (Issue #29)

**Decision**: Add an inline description to `schemas/paths/meta/global-stats.yaml` explaining the timezone limitation, plus a `docs/timezone-behavior.md` file for detailed documentation.

**Rationale**: Global stats is unauthenticated and aggregates across all users. In single-user mode, the timezone parameter shifts the date range anchor but the summary data is bucketed by the user's profile timezone. Since there's only one user, this is consistent. In multi-user mode (Milestone 4), cross-user aggregation by date is ambiguous because different users may have different bucketing timezones.

**Alternatives considered**: Rate-limiting, UTC-only for global stats → deferred to Milestone 4 per spec.
