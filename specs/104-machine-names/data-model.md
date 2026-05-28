# Data Model: Machine Names Endpoint

No schema changes. Uses the existing `machine_names` table; `heartbeats` is unchanged.

## `machine_names` (existing, unchanged)

```sql
CREATE TABLE IF NOT EXISTS machine_names (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  value TEXT NOT NULL,
  ip TEXT,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, value)
);
```

`UNIQUE(user_id, value)` is the conflict target for the ingestion upsert. `ON DELETE CASCADE` removes a user's machines when the user is deleted.

## Ingestion upsert

```sql
INSERT INTO machine_names (id, user_id, value, ip, last_seen_at, created_at)
VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
ON CONFLICT (user_id, value) DO UPDATE SET
  last_seen_at = datetime('now'),
  ip = excluded.ip;
```

- Bound params: `crypto.randomUUID()`, `userId`, `machine` value, `ip` (`CF-Connecting-IP` or null).
- Added to the existing heartbeat `db.batch()`; one statement per **distinct** persisted machine value per request.
- Only runs for persisted heartbeats (valid + not hidden by a custom rule).

## Read query

```sql
SELECT id, value, ip, last_seen_at, created_at
  FROM machine_names
 WHERE user_id = ?
 ORDER BY last_seen_at DESC;
```

Strictly `user_id`-scoped, so a caller never sees another user's machines or IPs.

## Field treatment in the read handler

| Column | Handler treatment |
|---|---|
| `id`, `value` | Pass through |
| `ip` | Pass through (null → omitted from the response object) |
| `last_seen_at`, `created_at` | `normalizeDateTime` → ISO 8601 (mirrors `user_agents`) |

## `heartbeats` (unchanged)

`heartbeats.machine` continues to store the raw machine string. No foreign key, no new column. The registry is derived alongside, not from a join.

## Cleanup / cascade

`machine_names` cascades on user delete. No per-machine delete endpoint (out of scope); the registry is ingestion-driven.
