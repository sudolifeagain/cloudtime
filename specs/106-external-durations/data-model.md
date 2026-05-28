# Data Model: External Durations

No schema changes. Uses the existing `external_durations` table.

## `external_durations` (existing, unchanged)

```sql
CREATE TABLE IF NOT EXISTS external_durations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'app',     -- file | app | domain
  category TEXT,
  start_time REAL NOT NULL,             -- epoch seconds
  end_time REAL NOT NULL,               -- epoch seconds
  project TEXT,
  branch TEXT,
  language TEXT,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_ext_durations_user_time ON external_durations(user_id, start_time);
```

`UNIQUE(user_id, external_id)` is the upsert conflict target. `idx_ext_durations_user_time` backs the day-scoped GET and DELETE.

## Write-path field treatment

| Field | Treatment |
|---|---|
| `id` | Server `crypto.randomUUID()` on insert; preserved on conflict-update |
| `user_id` | From the session; bound in every statement / WHERE |
| `external_id` | Required; conflict key |
| `entity` | Required, non-empty |
| `type` | Required, ∈ `file|app|domain` |
| `start_time` / `end_time` | Required, finite numbers (epoch seconds); `end_time` ≥ `start_time` |
| `category` / `project` / `branch` / `language` / `meta` | Optional strings, stored as-is or NULL |
| `created_at` | `datetime('now')` on insert; unchanged on update |

## Statements

### Create / bulk create (upsert)
```sql
INSERT INTO external_durations
  (id, user_id, external_id, entity, type, category, start_time, end_time, project, branch, language, meta)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT (user_id, external_id) DO UPDATE SET
  entity = excluded.entity, type = excluded.type, category = excluded.category,
  start_time = excluded.start_time, end_time = excluded.end_time,
  project = excluded.project, branch = excluded.branch,
  language = excluded.language, meta = excluded.meta;
```
Single create reads the row back (RETURNING or a follow-up SELECT) to return it. Bulk runs one `db.batch()` of upserts after validating all elements, then returns the persisted rows.

### List (day-scoped)
```sql
SELECT id, user_id, external_id, entity, type, category, start_time, end_time,
       project, branch, language, meta, created_at
  FROM external_durations
 WHERE user_id = ? AND start_time >= ? AND start_time < ?
   /* optional: AND project = ?  AND branch IN (?, …) */
 ORDER BY start_time ASC;
```
`?`/`?` are the local-day epoch bounds from `getEpochBoundsForDate(date, tz)`.

### Bulk delete
```sql
DELETE FROM external_durations
 WHERE user_id = ? AND start_time >= ? AND start_time < ? AND id IN (?, …);
```
Unknown / unowned ids simply do not match.

## Aggregation

None. External durations are a parallel series; the cron aggregator and `summaries` are untouched (see research Decision 2).

## Cleanup / cascade

`external_durations` cascades on user delete. No additional cleanup.
