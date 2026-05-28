# Data Model: Custom Rules CRUD + Heartbeat Remap

No schema changes. Uses the existing `custom_rules` table and existing `heartbeats` columns.

## `custom_rules` (existing, unchanged)

```sql
CREATE TABLE IF NOT EXISTS custom_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'change',     -- change | hide
  source TEXT NOT NULL,                       -- project | language | editor | operating_system | category | entity
  operation TEXT NOT NULL,                    -- equals | contains | starts_with | ends_with
  source_value TEXT NOT NULL,
  destination TEXT NOT NULL,                  -- change: target column; hide: "" (ignored)
  destination_value TEXT NOT NULL,            -- change: new value; hide: "" (ignored)
  priority INTEGER NOT NULL DEFAULT 0,        -- ascending application order
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_custom_rules_user ON custom_rules(user_id);
```

Note: the table has no `modified_at`. Because PUT is a full replace (rows are recreated), `created_at` alone is sufficient and acts as the deterministic tie-breaker within a priority.

### Write-path field treatment

| Column | PUT (per array element) |
|---|---|
| `id` | Server `crypto.randomUUID()`; input ignored |
| `user_id` | Authenticated user; bound in every INSERT |
| `action` | Required enum `change` / `hide` |
| `source` | Required dimension enum |
| `operation` | Required enum (no regex) |
| `source_value` | Required, non-empty |
| `destination` | Required for `change`; stored `""` for `hide` |
| `destination_value` | Required non-empty for `change`; stored `""` for `hide` |
| `priority` | Provided integer, else the array index |
| `created_at` | `datetime('now')`; input ignored |

## Statements issued

### List
```sql
SELECT id, action, source, operation, source_value, destination, destination_value,
       priority, created_at
  FROM custom_rules
 WHERE user_id = ?
 ORDER BY priority ASC, created_at ASC;
```

### Replace (PUT) — atomic batch
```sql
-- single db.batch([...]):
DELETE FROM custom_rules WHERE user_id = ?;
INSERT INTO custom_rules (id, user_id, action, source, operation, source_value,
                          destination, destination_value, priority)
VALUES (?,?,?,?,?,?,?,?,?);   -- one INSERT per validated element
```
Validation runs fully before the batch; a 400 means no statement executed.

### Delete
```sql
DELETE FROM custom_rules WHERE id = ? AND user_id = ?;   -- 404 when meta.changes === 0
```

## KV cache

- **Key**: `customrules:${user_id}`
- **Value**: JSON array of compiled rules, pre-sorted by `priority` then `created_at`.
- **Read**: heartbeat ingestion reads the cache; on miss it runs the List SELECT, sorts, and repopulates.
- **Invalidate**: `PUT` and `DELETE` delete the key. (An optional short TTL can be added later as a safety net; correctness comes from explicit invalidation.)

## Heartbeat remap (read of rules, mutation in memory)

The matcher reads these `heartbeats` columns as both match `source` and rewrite `destination` targets: `project`, `language`, `editor`, `operating_system`, `category`, `entity`. The heartbeat row is mutated **in memory** before the existing INSERT; no new columns, no extra D1 reads inside the loop. `hide` matches remove the heartbeat from the batch entirely.

## Cleanup / cascade

`custom_rules` has `ON DELETE CASCADE` from `users`; deleting a user removes their rules and (separately) their cache key expires naturally / is unused once the user is gone.
