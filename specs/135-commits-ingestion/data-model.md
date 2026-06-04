# Data Model: Commit ingestion (write path)

**Branch**: `135-commits-ingestion` | **Date**: 2026-06-05

## Storage

**No schema change.** The `commits` table and its uniqueness constraint already exist (`src/db/schema.sql`):

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

The `UNIQUE(user_id, project, hash)` constraint backs the idempotent upsert.

## Request → row mapping (PR2)

| Body field (`CommitInput`) | Column | Notes |
|---|---|---|
| — (path) | `project` | from the URL path, not the body (FR-008) |
| — (auth) | `user_id` | authenticated user |
| — (server) | `id` | `crypto.randomUUID()` on insert; unchanged on update |
| `hash` (required, non-empty) | `hash` | part of the dedup key |
| `message` | `message` | stored as given |
| `author_name` / `author_email` | `author_name` / `author_email` | |
| `author_date` (valid date-time if present) | `author_date` | `normalizeDateTime`; null if omitted |
| `committer_name` / `committer_email` | `committer_name` / `committer_email` | |
| `committer_date` (valid date-time if present) | `committer_date` | `normalizeDateTime`; null if omitted |
| `total_seconds` (number `>= 0` if present) | `total_seconds` | client-supplied; null if omitted |
| `ref` | `ref` | branch; read path filters `branch` against it |
| `url` | `url` | stored as given |

## Write path (PR2)

```sql
INSERT INTO commits
  (id, user_id, project, hash, message, author_name, author_email, author_date,
   committer_name, committer_email, committer_date, total_seconds, ref, url)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (user_id, project, hash) DO UPDATE SET
  message          = excluded.message,
  author_name      = excluded.author_name,
  author_email     = excluded.author_email,
  author_date      = excluded.author_date,
  committer_name   = excluded.committer_name,
  committer_email  = excluded.committer_email,
  committer_date   = excluded.committer_date,
  total_seconds    = excluded.total_seconds,
  ref              = excluded.ref,
  url              = excluded.url
```

`created_at` and `id` are preserved on update (only the row's mutable fields change). The handler then reads the stored row (or uses `RETURNING`) and shapes it through the existing `rowToCommit` for the `201` `{ data: Commit }` response — identical to the read endpoints.

## Read path (unchanged, #107)

`GET .../commits` (paginated, `author`/`branch` filters) and `GET .../commits/{hash}` already shape `commits` rows via `rowToCommit`, defaulting a missing `author_date` to `created_at`. Ingested rows flow through unchanged (FR-009).

## Untouched

Ingestion writes only `commits`. It does **not** modify `summaries`, `hourly_summaries`, or `user_projects` (FR-010) — commits are an independent series.
