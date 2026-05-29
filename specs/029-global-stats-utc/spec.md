# Feature Specification: Global Stats Always Aggregate in UTC

**Feature Branch**: `029-global-stats-utc`
**Created**: 2026-05-29
**Status**: Draft
**Input**: Issue #29 — the unauthenticated global stats endpoint (`GET /api/v1/stats/{range}`) accepts a `timezone` query parameter that is folded into the KV cache key and the date-range resolution. This fragments the cache and makes cross-user date aggregation ambiguous once `summaries.date` is bucketed per user timezone (#32).

## Background

`GET /api/v1/stats/{range}` aggregates activity across **all** users and is **unauthenticated** (`security: []`), served from a 5-minute KV cache. Today it:

- reads a `timezone` query param, validates it, and uses it to resolve the date range, and
- includes the timezone in the cache key (`global-stats:{range}:{tz}`) and the response `range.timezone`.

Two problems, both multi-user-relevant (harmless in single-user but worth fixing before `INSTANCE_MODE=multi`):

1. **Cache fragmentation / bypass** — each distinct `timezone` value creates a separate cache entry. On an unauthenticated endpoint an attacker can cycle timezones to bypass the cache and force repeated full aggregations.
2. **Cross-user date ambiguity** — `summaries.date` is bucketed in each user's local timezone (#32). A global aggregation `WHERE date BETWEEN …` mixes rows whose `date` means different absolute day boundaries per user, so a client-supplied timezone cannot give a coherent global answer.

## Decision

**Option 1 — global stats always aggregate in UTC.** The endpoint no longer accepts a `timezone`:

- The date range is resolved in UTC.
- The cache key is `global-stats:{range}` (one entry per range) — no longer fragmentable.
- The response `range.timezone` is always `"UTC"`.

This single change resolves **both** concerns. With the cache no longer fragmentable, per-IP rate-limiting (issue Option 3) is not required for this purpose and is left as optional future defense-in-depth.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Stable, cacheable global stats (Priority: P2)

As an operator, I want global stats to be cheap and consistent regardless of client-supplied timezones, so the unauthenticated endpoint can't be abused to bypass the cache.

**Independent Test**: Seed summaries. `GET /stats/last_7_days` and `GET /stats/last_7_days?timezone=Asia/Tokyo` return the **same** data, both report `range.timezone = "UTC"`, and both are served from the same cache entry (the second is a cache hit of the first).

**Acceptance Scenarios**:
1. **Given** any `timezone` query value, **When** requesting global stats, **Then** the result is identical to omitting it and `range.timezone` is `"UTC"`.
2. **Given** two requests for the same `range` with different `timezone` values, **When** served, **Then** they hit a single cache entry (`global-stats:{range}`).
3. **Given** an invalid `timezone` value, **When** requesting, **Then** the request still succeeds in UTC (the param is ignored, not validated) — no 400 for the timezone.
4. **Given** an invalid `range`, **When** requesting, **Then** 400 (unchanged).

---

### Edge Cases

- **Existing clients sending `?timezone=`**: the param is silently ignored (Hono does not 400 on unknown query params); responses are UTC.
- **`all_time`**: unchanged — UTC bounds, with the daily-average denominator still anchored to the first data date.
- **Cache entries from the old key format**: the old `global-stats:{range}:{tz}` entries simply age out (5-min TTL); the new key is `global-stats:{range}`.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `GET /api/v1/stats/{range}` MUST resolve the range and aggregate in UTC, ignoring any `timezone` query parameter.
- **FR-002**: The KV cache key MUST be `global-stats:{range}` (no timezone component).
- **FR-003**: The response `range.timezone` MUST be `"UTC"`.
- **FR-004**: A supplied `timezone` MUST NOT cause a 400; it is ignored. Range validation (400 on bad `range`) is unchanged.
- **FR-005**: The OpenAPI operation MUST NOT declare a `timezone` parameter.

### Non-Functional Requirements

- **NFR-001**: No behavioural change to the authenticated per-user `GET /users/current/stats/{range}` (which legitimately uses the user's timezone).
- **NFR-002**: No D1 schema change; no new binding. (Issue Option 4 — a UTC date column — is **not** adopted; UTC range bounds over the existing per-user `date` is the pragmatic global view for now.)

### Key Entities *(no schema change)*

Reads the existing `summaries` table. No new columns. `summaries.date` remains per-user-local; the global endpoint simply treats the requested range bounds as UTC dates.

## Success Criteria *(mandatory)*

- **SC-001**: `?timezone=…` no longer changes the response or creates a new cache entry.
- **SC-002**: `range.timezone` is always `"UTC"` on global stats.
- **SC-003**: The OpenAPI no longer advertises a `timezone` param for `getGlobalStats`.
- **SC-004**: The authenticated per-user stats endpoint is unchanged.

## Out of Scope

- **Per-IP rate limiting** of the endpoint (Option 3) — unnecessary once the cache is un-fragmentable; optional future hardening.
- **A separate UTC date column** in `summaries` (Option 4) — deferred; revisit if true per-user-timezone global aggregation is needed in multi-user mode.
- **The authenticated per-user stats** endpoint and its timezone handling.
