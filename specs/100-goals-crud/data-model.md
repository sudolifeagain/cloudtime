# Data Model: Goals CRUD Endpoints

No schema changes. This document describes how the write path uses the existing `goals` table.

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

The table already supports everything the CRUD endpoints need. The DB-level defaults (`type='coding'`, `is_enabled=1`, the timestamps) are a backstop; the application supplies explicit values so behaviour does not depend on DB defaults.

## Write-path field treatment

| Field | Create (`POST`) | Update (`PATCH`) |
|---|---|---|
| `id` | Server `crypto.randomUUID()`; body value ignored | Path param; never in body |
| `user_id` | From the authenticated session; always bound in `WHERE`/`INSERT` | Always bound in `WHERE` |
| `title` | Required, trimmed, 1–200 chars | Optional; same rule when present |
| `type` | Required enum | **Rejected if present (400)** |
| `delta` | Required enum | **Rejected if present (400)** |
| `target_seconds` | Required, `0 < x <= 604800` | Optional; same rule when present |
| `is_enabled` | Optional, default `true` → stored as 1/0 | Optional → 1/0 |
| `is_snoozed` | Optional, default `false` → 1/0 | Optional → 1/0 |
| `is_inverse` | Optional, default `false` → 1/0 | Optional → 1/0 |
| `languages`/`editors`/`projects` | Validated against `type`, de-duplicated, `JSON.stringify` (or NULL when empty/omitted for `coding`) | Same; must stay consistent with the goal's existing `type`; a filtered goal's array must stay non-empty |
| `created_at` | DB/`datetime('now')`; body value ignored | Never changed |
| `modified_at` | Set on insert | Set to `datetime('now')` on every successful update |

### Filter-array ↔ `type` consistency matrix

| `type` | `languages` | `editors` | `projects` |
|---|---|---|---|
| `coding` | empty/omit | empty/omit | empty/omit |
| `languages` | **non-empty** | empty/omit | empty/omit |
| `editors` | empty/omit | **non-empty** | empty/omit |
| `projects` | empty/omit | empty/omit | **non-empty** |

Any cell violated → 400. Empty arrays are stored as SQL `NULL` (the read path's `parseFilterArray` treats `NULL` and `[]` identically).

## Statements issued

### Create
```sql
INSERT INTO goals (id, user_id, title, type, delta, target_seconds,
                   is_enabled, is_snoozed, is_inverse, languages, editors, projects)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?);
-- followed by the existing single-goal SELECT to echo the persisted row
```

### Update
```sql
-- 1) ownership + current type:
SELECT <GOAL_COLUMNS> FROM goals WHERE id = ? AND user_id = ?;   -- 404 if no row
-- 2) dynamic SET built from provided fields only, always including modified_at:
UPDATE goals SET <field = ?>, ..., modified_at = datetime('now')
 WHERE id = ? AND user_id = ?;
-- 3) re-SELECT to return merged state
```

### Delete
```sql
DELETE FROM goals WHERE id = ? AND user_id = ?;   -- 404 if meta.changes === 0
```

All statements are parameter-bound; no string interpolation of user input into SQL. The dynamic `UPDATE` builds its `SET` list from a fixed allowlist of column names, binding values positionally — column names are never taken from user input.

## Reuse of the read path

- `rowToGoal(row)` (already in `src/routes/goals.ts`) serialises a row to the `Goal` response shape, including decoding the JSON filter columns. Create and update responses go through it unchanged.
- `GOAL_COLUMNS` and the single-goal `SELECT` are reused for the post-write re-read and the PATCH ownership check.

## Cleanup / cascade

`goals` has `ON DELETE CASCADE` from `users`; deleting a user still removes their goals automatically. The new `DELETE` endpoint removes a single goal explicitly. No additional cleanup logic.
