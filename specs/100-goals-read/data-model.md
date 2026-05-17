# Data Model: Goals Read Endpoints

No schema changes. This document describes how existing tables drive the read endpoints.

## `goals` (existing, unchanged)

```sql
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'coding',       -- coding | languages | editors | projects
  delta TEXT NOT NULL DEFAULT 'day',         -- day | week
  target_seconds REAL NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  is_snoozed INTEGER NOT NULL DEFAULT 0,
  is_inverse INTEGER NOT NULL DEFAULT 0,
  languages TEXT,                            -- JSON array (nullable)
  editors TEXT,                              -- JSON array (nullable)
  projects TEXT,                             -- JSON array (nullable)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  modified_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);
```

### Field treatment in handlers

| Column | Handler treatment |
|---|---|
| `id`, `title`, `created_at`, `modified_at` | Pass through |
| `type` | Validate against enum on read; fall back to `coding` if unknown |
| `delta` | Validate against enum on read; fall back to `day` |
| `target_seconds` | Number, no transformation |
| `is_enabled`, `is_snoozed`, `is_inverse` | INTEGER 0/1 → boolean |
| `languages`, `editors`, `projects` | JSON.parse → string[]; non-array or parse error ⇒ `[]` with warning log |

## `summaries` (existing, unchanged)

```sql
CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,                  -- YYYY-MM-DD in user's profile timezone
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
```

This is the only data source for `actual_seconds`. The cron aggregator already buckets rows in the user's profile timezone, so the goal chart can scan by `date BETWEEN ? AND ?` without re-doing TZ math.

### Chart computation query shape

For a `delta=day` goal:

```sql
SELECT date, SUM(total_seconds) AS actual_seconds
  FROM summaries
 WHERE user_id = ?
   AND date BETWEEN ? AND ?     -- (today - 6) .. today, in user's local calendar
   /* type-specific filter applied here, e.g.:                                          */
   /*   AND language IN (?,?,?)   for type=languages                                    */
 GROUP BY date
 ORDER BY date ASC;
```

For a `delta=week` goal, the same query but the WHERE clause spans the last 7 ISO weeks (so 49 days), and we re-bucket the daily rows into weeks in TypeScript using the same Monday-Sunday boundaries the cron aggregator's timezone helper provides.

### Filter SQL fragments

| `type` | Filter |
|---|---|
| `coding` | (none — sum across all summaries) |
| `languages` | `AND language IN (?, ?, ...)` — placeholders correspond to the goal's `languages` array. Empty array ⇒ filter is `AND 0` (matches nothing). |
| `editors` | `AND editor IN (?, ?, ...)` |
| `projects` | `AND project IN (?, ?, ...)` |

### Period count vs query count

The single-goal endpoint issues two D1 queries:
1. `SELECT … FROM goals WHERE id = ? AND user_id = ?`
2. The summary aggregation query above.

No N+1. No per-period query.

## Domain types (TypeScript, not in D1)

```ts
type DateString = string;       // YYYY-MM-DD
type TimeRange = { date: DateString; start: string; end: string };

interface ChartEntry {
  actual_seconds: number;
  goal_seconds: number;          // always === goal.target_seconds (denormalised per WakaTime convention)
  range: TimeRange;
  range_status: "success" | "fail" | "pending";
}

interface GoalForRead {
  // ...all of the existing Goal columns decoded to their TS types
  chart_data?: ChartEntry[];     // present only on single-goal endpoint
  status?: "success" | "fail" | "pending"; // present only on single-goal endpoint
}
```

## Cleanup / cascade

`goals` has `ON DELETE CASCADE` from `users`. When a user is deleted, their goals are removed automatically. No additional cleanup logic in this feature.
