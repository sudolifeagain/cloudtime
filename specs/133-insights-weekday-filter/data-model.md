# Data Model: `weekday` filter for the `days` insight

**Branch**: `133-insights-weekday-filter` | **Date**: 2026-06-04

## Storage

**No schema change.** No new table, column, index, or migration. The feature reads only the existing `summaries` rows the endpoint already queries.

## Read path (unchanged from #103)

The route issues the same single grouped SELECT introduced in #103:

```sql
SELECT date, project, language, editor, operating_system, category, branch, machine,
       SUM(total_seconds) AS total_seconds
  FROM summaries
 WHERE user_id = ? AND date BETWEEN ? AND ?
 GROUP BY date, project, language, editor, operating_system, category, branch, machine
```

`date` is the user-profile-timezone calendar date as bucketed by the hourly aggregation cron.

## Derived in memory

| Concept | Source | Notes |
|---|---|---|
| Per-date totals | `dailyTotals(rows)` (existing) | `Map<date, total_seconds>` summed across dimensions. |
| Weekday of a date | `weekdayOf(date)` (existing) | `new Date(\`${date}T00:00:00Z\`).getUTCDay()` → 0=Sunday … 6=Saturday. |
| **`weekday` filter** (new) | normalised request value `0–6 \| null` | When non-null and `insight_type==="days"`, keep only dates with `weekdayOf(date) === filter`. |

## Request parameter normalisation (new, PR2)

| Input form | Examples | Normalised |
|---|---|---|
| Omitted | (no `weekday`) | `null` (no filter) |
| Integer 0–6 | `0`, `6` | that integer |
| Full name (case-insensitive, trimmed) | `monday`, `MONDAY`, ` monday ` | 0–6 via name→index map |
| Invalid (only enforced for `days`) | `7`, `-1`, `funday`, `` (blank) | → 400 for `days`; ignored (treated as `null`) for other types |

## Response shape

Unchanged. `days[]` entries keep `{date, total_seconds, text}` and ascending-by-date order; filtering only removes non-matching entries (possibly yielding `[]`).
