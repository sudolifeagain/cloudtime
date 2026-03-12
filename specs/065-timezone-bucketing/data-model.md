# Data Model: Timezone-Aware Summary Bucketing

## Existing Entities (No Schema Changes Required)

### User

| Field | Type | Notes |
|-------|------|-------|
| id | TEXT PK | UUID |
| timezone | TEXT NOT NULL DEFAULT 'UTC' | IANA timezone string. Already exists. Used by cron for bucketing. |
| timeout | INTEGER NOT NULL DEFAULT 15 | Minutes. Already exists. |

**Validation**: `Intl.DateTimeFormat(undefined, { timeZone: value })` — already implemented in `users.ts`.

### Summary

| Field | Type | Notes |
|-------|------|-------|
| user_id | TEXT FK | References users.id |
| date | TEXT NOT NULL | YYYY-MM-DD in user's **local timezone** at aggregation time |
| project, language, editor, ... | TEXT | Dimension columns |
| total_seconds | REAL | Aggregated duration |

**Unique constraint**: `(user_id, date, project, language, editor, operating_system, category, branch, machine)`

**Key behavior**: `date` is already bucketed by user's profile timezone in `src/cron/aggregate.ts`. When a user changes timezone, old rows retain their original date values (FR-007).

### Heartbeat

| Field | Type | Notes |
|-------|------|-------|
| time | REAL NOT NULL | UNIX epoch seconds (UTC). Timezone-agnostic. |

No changes to heartbeat storage or schema.

## Context Changes (Runtime Only)

### AuthEnv Context Extension

The `authMiddleware` context needs to expose the user's timezone alongside `userId`:

| Context Key | Type | Source |
|-------------|------|--------|
| userId | string | Already exists in auth middleware |
| userTimezone | string | New — from `users.timezone` column, included in auth query/cache |

This is a runtime change only — no DB schema migration required.

## State Transitions

No new state machines. The only state-relevant behavior is:

1. User changes timezone → future cron runs use new timezone → old summaries unchanged
2. Query without `?timezone` → resolves to `c.get("userTimezone")` instead of "UTC"

## Data Volume / Scale

No impact on data volume. Summary rows are not duplicated or re-created. The only change is how query date ranges are anchored.
