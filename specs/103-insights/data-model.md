# Data Model: Insights Endpoint

No schema changes. `summaries` is the only data source.

## `summaries` (existing, unchanged)

```sql
CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,                 -- YYYY-MM-DD in the user's profile timezone
  project TEXT,
  language TEXT,
  editor TEXT,
  operating_system TEXT,
  category TEXT,
  branch TEXT,
  machine TEXT,
  entity TEXT,
  total_seconds REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_unique
  ON summaries(user_id, date, project, language, editor, operating_system, category, branch, machine);
```

`date` is already timezone-bucketed by the cron aggregator, so insights group on `date` directly and derive weekday from the local date — no TZ math at query time.

## Range resolution

`resolveStatsRange(range, tz)` → `{ start, end, text }` (inclusive `YYYY-MM-DD` bounds). Reused verbatim from `/stats`. Invalid range → handler returns 400.

## Read query (one grouped SELECT per request)

```sql
SELECT date, project, language, editor, operating_system, category, machine,
       SUM(total_seconds) AS total_seconds
  FROM summaries
 WHERE user_id = ? AND date BETWEEN ? AND ?
 GROUP BY date, project, language, editor, operating_system, category, machine;
```

The handler shapes these rows in memory per `insight_type`. (A dimension insight could alternatively issue a narrower `GROUP BY <column>`; either way it is a single query.)

## Per-type shaping

| `insight_type` | Output field | Computation |
|---|---|---|
| `projects` / `languages` / `editors` / `categories` / `machines` / `operating_systems` | `items[]` | Sum `total_seconds` grouped by the column; NULL → `"Unknown"`; order desc; `percent` = share of range total; `digital`/`text`/`hours`/`minutes`/`seconds` via the shared formatter. |
| `days` | `days[]` | Sum per `date`; active dates ascending; `{date, total_seconds, text}`. |
| `best_day` | `best_day` | The date with max summed `total_seconds` (ties → earliest); zeroed if none. |
| `daily_average` | `daily_average` | `{seconds = total ÷ active-day count, text}`; 0 when no active days. |
| `weekday` | `items[]` | Group active days by weekday; `total_seconds` = mean of that weekday's active-day totals; `name` = English weekday; order desc. |

`data.type` = requested `insight_type`; `data.range` = resolved `TimeRange` (`start`, `end`, `text`, `timezone = tz`).

## Formatting reuse

`digital` (H:MM), `text` (e.g. "2 hrs 30 mins"), and `hours`/`minutes`/`seconds` are produced by the same duration-formatting helper `/stats` uses to build `SummaryItem`s — not reimplemented.

## No writes / cascade

Read-only. No inserts, no schema change, no cleanup. `summaries` already cascades on user delete.
