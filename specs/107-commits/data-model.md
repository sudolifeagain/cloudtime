# Data Model: Commits Read Endpoints

No schema changes. Reads the existing `commits` table.

## `commits` (existing, unchanged)

```sql
CREATE TABLE IF NOT EXISTS commits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project TEXT NOT NULL,
  hash TEXT NOT NULL,
  message TEXT,
  author_name TEXT,
  author_email TEXT,
  author_date TEXT,
  committer_name TEXT,
  committer_email TEXT,
  committer_date TEXT,
  total_seconds REAL,
  ref TEXT,
  url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, project, hash)
);
```

`UNIQUE(user_id, project, hash)` backs the single-commit lookup and per-user/project scoping. `total_seconds` is nullable (a commit may have no time attribution).

## Read queries

### List (paginated)
```sql
-- count for total_pages:
SELECT COUNT(*) AS n FROM commits
 WHERE user_id = ? AND project = ?
   /* optional: AND author_email = ?  AND ref = ? */;

-- page:
SELECT hash, message, author_name, author_email, author_date,
       committer_name, committer_email, committer_date, total_seconds, ref, url
  FROM commits
 WHERE user_id = ? AND project = ?
   /* optional filters as above */
 ORDER BY author_date DESC, hash ASC
 LIMIT 100 OFFSET ?;          -- OFFSET = (page - 1) * 100
```

`total_pages = ceil(n / 100)` (0 when `n = 0`).

### Single
```sql
SELECT hash, message, author_name, author_email, author_date,
       committer_name, committer_email, committer_date, total_seconds, ref, url
  FROM commits
 WHERE user_id = ? AND project = ? AND hash = ?;   -- 404 when no row
```

## Field treatment in the handler (`rowToCommit`)

| Column | Treatment |
|---|---|
| `hash`, `message`, `author_name`, `author_email` | Pass through (null → omitted) |
| `author_date`, `committer_date` | `normalizeDateTime` → ISO 8601 |
| `committer_name`, `committer_email`, `ref`, `url` | Pass through |
| `total_seconds` | Pass through (null → 0 / omitted) |
| `human_readable_total` | `formatHumanReadable(total_seconds ?? 0)` |

`id`, `user_id`, `created_at`, `project` are not part of the `Commit` response schema and are not surfaced.

## No writes

Read-only. No ingestion path in this feature (see research Decision 1). `commits` cascades on user delete.
