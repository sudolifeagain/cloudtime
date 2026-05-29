# Data Model: Data Dumps (Export)

No D1 schema changes. Adds an R2 binding (PR2) and uses the existing
`data_dumps` table plus R2 objects.

## `data_dumps` (existing, unchanged)

```sql
CREATE TABLE IF NOT EXISTS data_dumps (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'daily',        -- daily | full
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | processing | completed | failed | expired
  download_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

The application owns the `type` / `status` vocabularies (the column has no CHECK), so the enum reconciliation is contract-only.

## R2 (new binding in PR2)

- **Binding**: `R2_BUCKET` (optional). The feature is gated on its presence.
- **Object key**: `dumps/{user_id}/{dump_id}.json`.
- **Lifecycle**: written by the cron on `completed`; deleted by the cron on expiry.

## Lifecycle / statements

### Create (POST)
```sql
-- dedupe: reuse an in-flight dump of the same type
SELECT * FROM data_dumps
 WHERE user_id = ? AND type = ? AND status IN ('pending','processing')
 ORDER BY created_at DESC LIMIT 1;
-- else insert pending:
INSERT INTO data_dumps (id, user_id, type, status) VALUES (?, ?, ?, 'pending');
```

### List (GET)
```sql
SELECT id, type, status, download_url, created_at, expires_at
  FROM data_dumps WHERE user_id = ? ORDER BY created_at DESC;
```

### Cron — build pending
```sql
SELECT id, user_id, type FROM data_dumps WHERE status = 'pending' LIMIT N;   -- bounded per run
UPDATE data_dumps SET status = 'processing' WHERE id = ?;
-- build bundle → R2.put(key, json) →
UPDATE data_dumps SET status = 'completed', download_url = ?, expires_at = datetime('now','+7 days') WHERE id = ?;
-- on error:
UPDATE data_dumps SET status = 'failed' WHERE id = ?;
```

### Cron — purge expired
```sql
SELECT id, user_id FROM data_dumps
 WHERE status = 'completed' AND expires_at IS NOT NULL AND expires_at < datetime('now');
-- R2.delete(key) → UPDATE data_dumps SET status = 'expired', download_url = NULL WHERE id = ?;
```

## Export bundle shape (JSON object stored in R2)

```jsonc
// daily
{ "user": { … profile … },
  "summaries": [ { "date": "YYYY-MM-DD", "total_seconds": n, … } ] }

// full
{ "user": { … },
  "summaries": [ … ],
  "daily": [ { "date": "YYYY-MM-DD", … per-day rollup … } ],
  "heartbeats": [ { … raw heartbeat … } ] }
```

Built by `src/utils/export-bundle.ts` from D1 reads (`users`, `summaries`, `heartbeats`), all `user_id`-scoped.

## Field treatment (`rowToDump`)

| Column | Treatment |
|---|---|
| `id`, `type`, `status` | Pass through (enums) |
| `download_url` | Present only when `status = completed` and unexpired; else omitted |
| `created_at` | Always present; `normalizeDateTime` → ISO 8601 |
| `expires_at` | `normalizeDateTime` → ISO 8601 when present; omitted when null |

`user_id` is not surfaced in the `DataDump` response.

## Cleanup / cascade

`data_dumps` cascades on user delete. R2 objects are purged by the expiry sweep; orphaned objects from a deleted user are a known minor follow-up (a future cron could reconcile R2 against D1).
