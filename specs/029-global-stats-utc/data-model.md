# Data Model: Global Stats Always Aggregate in UTC

No schema changes. Reads the existing `summaries` table; only the global
endpoint's range/cache handling changes.

## `summaries` (existing, unchanged)

`summaries.date` is `YYYY-MM-DD` bucketed in **each user's profile timezone**
by the cron aggregator (#32). That is correct for per-user views.

For the **global** endpoint, the requested range is resolved to UTC date
bounds and applied directly to `date`:

```sql
-- range bounds resolved in UTC (no client timezone)
SELECT COALESCE(SUM(total_seconds), 0) AS total_seconds, MIN(date) AS min_date
  FROM summaries WHERE date >= ? AND date <= ?;
-- + GROUP BY category / language / editor / operating_system (unchanged)
```

This treats every user's local `date` as if it were a UTC date for the
purpose of the global rollup. It is an approximation (a user near a day
boundary in a far-from-UTC timezone may land in an adjacent global day), but
it is single-valued and cache-stable — the right trade-off for an aggregate,
unauthenticated view. Exact per-timezone global aggregation would require a
separate UTC date column (issue Option 4), which is deferred.

## KV cache key

- **Before**: `global-stats:{range}:{tz}` — fragmented per timezone.
- **After**: `global-stats:{range}` — one entry per range; 5-minute TTL
  unchanged. Old keys age out.

## Response

`GlobalStats.range.timezone` is always `"UTC"`. All other fields unchanged.

## No writes / migration

Read-only endpoint. No D1 migration, no new column, no new binding.
