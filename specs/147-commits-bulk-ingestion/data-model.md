# Data Model: Bulk commit ingestion

**Branch**: `147-commits-bulk-ingestion` | **Date**: 2026-07-09

## Storage

**No schema change.** The bulk endpoint writes the same `commits` table and columns the single endpoint (#135) writes, once per element. The `(user_id, project, hash)` UNIQUE constraint backs the per-element idempotent upsert (`src/db/schema.sql`):

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

## Request

The request body is a JSON **array** of `CommitInput` (the same element schema the single endpoint accepts). `project` is the path segment, applied to every element; a `project` field inside an element is ignored (FR-008).

| Constraint | Value | Behavior |
|---|---|---|
| body type | JSON array | non-array → `400` (FR-003) |
| `maxItems` | 100 | more → `400`, nothing written (FR-003, research D-4) |
| empty array | allowed | `201 { data: [] }`, nothing written (FR-003) |
| per element | `CommitInput` | validated by `validateCommitInput`; first invalid element → `400 item {i}: {message}`, nothing written (FR-002) |

### Per-element request → row mapping (PR2)

Identical to the single endpoint; applied once per array element.

| Body field (`CommitInput`) | Column | Notes |
|---|---|---|
| — (path) | `project` | from the URL path, not the element (FR-008) |
| — (auth) | `user_id` | authenticated user |
| — (server) | `id` | `crypto.randomUUID()` on insert; unchanged on update |
| `hash` (required, non-empty) | `hash` | part of the dedup key |
| `message` | `message` | stored as given |
| `author_name` / `author_email` | `author_name` / `author_email` | |
| `author_date` (valid date-time if present) | `author_date` | `normalizeDateTime`; null if omitted |
| `committer_name` / `committer_email` | `committer_name` / `committer_email` | |
| `committer_date` (valid date-time if present) | `committer_date` | `normalizeDateTime`; null if omitted |
| `total_seconds` (number `>= 0` if present) | `total_seconds` | client-supplied; **null if omitted — bulk does not correlate** (FR-005) |
| `ref` | `ref` | branch; read path filters `branch` against it |
| `url` | `url` | stored as given |

## Write path (PR2)

All validated elements are persisted in **one** `db.batch()` — one D1 round-trip, one implicit transaction (FR-004, FR-011). Each statement is the existing `commits` upsert, bound per element:

```ts
// pseudocode — mirrors external_durations.bulk (src/routes/external-durations.ts)
const batchResults = await c.env.DB.batch<CommitRow>(
  validated.map((v) => commitUpsertStmt(c.env.DB, userId, project, v)),
);
const data = batchResults
  .map((res) => res.results?.[0])
  .filter((row): row is CommitRow => row !== undefined)
  .map(rowToCommit);
return c.json({ data }, 201); // request order preserved by db.batch()
```

`commitUpsertStmt` binds the existing `UPSERT_SQL`:

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
RETURNING <SELECT_COLUMNS>
```

`created_at` and `id` are preserved on update; only mutable fields change. Each returned row is shaped through the existing `rowToCommit` for the `201 { data: Commit[] }` response — identical to the read/single-create endpoints.

**No correlation query.** Unlike the single endpoint, the bulk handler issues no previous-commit / window-bounds read and no heartbeat scan (FR-005, FR-011); an omitted `total_seconds` is bound as `null`.

**In-batch duplicate `(project, hash)`** (research D-5): statements run in array order within the one transaction, so a second occurrence's `ON CONFLICT DO UPDATE` sees the first and updates it — last-wins persisted, exactly like re-posting. The response preserves input cardinality: the `batchResults.map(...)` above yields one `Commit` per input element in request order (the earlier occurrence's `RETURNING` is its pre-overwrite snapshot, the later's is last-wins), while only the single last-wins row persists — a follow-up read returns exactly one row for that `(project, hash)`.

## Read path (unchanged, #107)

`GET .../commits` (paginated, `author`/`branch` filters) and `GET .../commits/{hash}` already shape `commits` rows via `rowToCommit`, defaulting a missing `author_date` to `created_at`. Bulk-ingested rows flow through unchanged (FR-009).

## Untouched

Bulk ingestion writes only `commits`. It does **not** modify `summaries`, `hourly_summaries`, or `user_projects` (FR-010) — commits are an independent series.
