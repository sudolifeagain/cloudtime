# Data Model: `hours`-of-day insight

**Branch**: `134-insights-hours-of-day` | **Date**: 2026-06-05

## New table: `hourly_summaries` (PR1, `src/db/schema.sql`)

Hour-of-day pre-aggregate. One row per (`user_id`, local `date`, local `hour`), with an accumulating `total_seconds`. Maintained by the same hourly cron pass as `summaries`.

```sql
CREATE TABLE IF NOT EXISTS hourly_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,          -- YYYY-MM-DD, user-profile-timezone calendar date
  hour INTEGER NOT NULL,       -- 0..23, user-profile-timezone hour-of-day
  total_seconds REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hourly_summaries_unique
  ON hourly_summaries(user_id, date, hour);
```

Mirrors the `summaries` shape (AUTOINCREMENT id + a unique index that backs the cron's `ON CONFLICT … DO UPDATE SET total_seconds = total_seconds + excluded.total_seconds` UPSERT). The unique key also serves the read query's `WHERE user_id = ? AND date BETWEEN ? AND ?` prefix.

**Granularity note**: at most 24 rows per active day per user — equal to or below `summaries`, which stores one row per dimension tuple (project/language/editor/…) per day. Acceptable for D1 at single-user scale.

## Write path (PR2 — cron, same pass as `summaries`)

The existing `computeDurations` walk in `src/cron/aggregate.ts` already attributes each interval `[prev, curr)` to the owning heartbeat `prev` and computes `date = getDateForTimestamp(prev.time, tz)`. PR2 additionally computes `hour = getHourForTimestamp(prev.time, tz)` (0–23) and accumulates a second map keyed by `${userId}|${date}|${hour}`. Both maps are flushed in the **same** `db.batch()` and the **same** `last_aggregated_at` cursor advance, so a single heartbeat scan feeds both aggregates (FR-008).

```sql
INSERT INTO hourly_summaries (user_id, date, hour, total_seconds)
VALUES (?, ?, ?, ?)
ON CONFLICT (user_id, date, hour)
DO UPDATE SET total_seconds = total_seconds + excluded.total_seconds
```

## Read path (PR2 — `hours` insight)

For `insight_type === "hours"`, the route issues a single read against the new aggregate (no `heartbeats` scan, FR-006):

```sql
SELECT date, hour, total_seconds
  FROM hourly_summaries
 WHERE user_id = ? AND date BETWEEN ? AND ?
```

`date` / `hour` are already the user-profile-timezone calendar date and hour as bucketed by the cron.

## Derived in memory (PR2 — pure builder)

| Concept | Source | Notes |
|---|---|---|
| Per-hour sum | fold rows by `hour` | `Map<hour, Σ total_seconds>` over the range. |
| Active days | `new Set(rows.map(r => r.date)).size` | distinct dates with any activity → the mean denominator (FR-004). |
| Bucket mean | `sum[h] / activeDays` (0 when `activeDays === 0`) | one value per hour. |
| `hours[]` | hours `0…23` | 24 entries, ascending; `{ hour, total_seconds: mean, text: formatHumanReadable(round(mean)) }`. Zero-activity hours → `total_seconds: 0`. |

**Invariant** (SC-002): `Σ_{h=0..23} hours[h].total_seconds === daily_average.seconds` for the same range, because both equal `grandTotal / activeDays`.

## Response shape (PR1 — `Insight` schema)

Additive: a new optional `hours` array on `components/schemas/Insight.yaml`. No existing field changes.

```yaml
hours:
  type: array
  items:
    type: object
    properties:
      hour:          { type: integer, minimum: 0, maximum: 23 }
      total_seconds: { type: number, format: double }
      text:          { type: string }
```
