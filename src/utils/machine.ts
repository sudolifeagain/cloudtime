/**
 * Helper for maintaining the `machine_names` per-device registry from
 * heartbeat ingestion (Issue #104).
 *
 * Unlike user agents, `machine` is not foreign-keyed onto `heartbeats` — the
 * raw string stays on the heartbeat row. This registry is upserted alongside,
 * keyed by UNIQUE(user_id, value), so the same device returns to the same row
 * across heartbeats. No RETURNING is needed; the statement is folded into the
 * existing heartbeat `db.batch()`.
 */

const MACHINE_UPSERT_SQL = `INSERT INTO machine_names (id, user_id, value, ip, last_seen_at, created_at)
VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
ON CONFLICT (user_id, value) DO UPDATE SET
  last_seen_at = datetime('now'),
  ip = excluded.ip`;

/** Build the upsert statement registering one device for a user. */
export function machineUpsertStmt(
  db: D1Database,
  userId: string,
  value: string,
  ip: string | null,
): D1PreparedStatement {
  return db.prepare(MACHINE_UPSERT_SQL).bind(crypto.randomUUID(), userId, value, ip);
}
