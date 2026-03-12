/**
 * Check if heartbeat aggregation is recent (within 2 hours).
 */
export async function checkUpToDate(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT value FROM meta WHERE key = 'last_aggregated_at'")
    .first<{ value: string }>();
  const lastAggregatedAt = row ? Number(row.value) : 0;
  return (Date.now() / 1000 - lastAggregatedAt) < 7200;
}
