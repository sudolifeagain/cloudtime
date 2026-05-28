/**
 * Heartbeat retention purge (Issue #108).
 *
 * The UI surfaces (`/summaries`, `/stats`) read from the pre-aggregated
 * `summaries` table, not from raw heartbeats, so old raw heartbeats can be
 * discarded once the operator's retention window has passed without losing
 * the rollup. Only `GET /heartbeats?date=…` for old days is affected.
 *
 * Runs inside the hourly cron, throttled with a per-run row cap so a large
 * backlog clears over several cycles rather than hammering D1 in one shot.
 */

export const DEFAULT_PURGE_LIMIT = 1000;
const SECONDS_PER_DAY = 86400;

/**
 * Parse the `HEARTBEAT_RETENTION_DAYS` env value. Returns the positive number
 * of days, or null when retention is disabled (unset / blank / non-positive /
 * non-numeric) — null means "retain forever".
 */
export function parseRetentionDays(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Delete up to `limit` heartbeats older than `retentionDays` days. Returns the
 * number of rows deleted so the caller can log progress / detect a backlog.
 *
 * `heartbeats.time` is epoch seconds. The cutoff (now − retentionDays days) is
 * always far older than the aggregator's lookback window (minutes), so this
 * never removes data the recent-window aggregation still needs.
 *
 * Uses a subquery-bounded DELETE (`id IN (SELECT … LIMIT ?)`) because SQLite /
 * D1 do not support `DELETE … LIMIT` directly. The `idx_heartbeats_time` index
 * backs the time filter.
 */
export async function purgeOldHeartbeats(
  db: D1Database,
  retentionDays: number,
  limit: number = DEFAULT_PURGE_LIMIT,
): Promise<number> {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;

  const cutoff = Date.now() / 1000 - retentionDays * SECONDS_PER_DAY;
  const res = await db
    .prepare(
      `DELETE FROM heartbeats
        WHERE id IN (SELECT id FROM heartbeats WHERE time < ? LIMIT ?)`,
    )
    .bind(cutoff, limit)
    .run();

  return res.meta.changes ?? 0;
}
