/**
 * Async data-dump processing run by the hourly cron (Issue #102): build
 * pending dumps into R2, and purge expired ones. Both are no-ops when
 * `R2_BUCKET` is unbound (the create endpoint 503s in that case anyway).
 */
import type { Env } from "../types";
import { buildDailyExport, buildFullExport, dumpObjectKey } from "../utils/export-bundle";

const BUILD_LIMIT = 5; // bound per cron run to stay within budget; backlog clears over cycles

function downloadPath(env: Env, dumpId: string): string {
  const base = env.APP_URL ?? "";
  return `${base}/api/v1/users/current/data_dumps/${dumpId}/download`;
}

/** Build up to BUILD_LIMIT pending dumps: pending → processing → completed/failed. */
export async function processPendingDumps(env: Env): Promise<void> {
  if (!env.R2_BUCKET) return;

  const { results } = await env.DB.prepare(
    `SELECT id, user_id, type FROM data_dumps WHERE status = 'pending'
      ORDER BY created_at ASC LIMIT ?`,
  )
    .bind(BUILD_LIMIT)
    .all<{ id: string; user_id: string; type: string }>();

  for (const dump of results) {
    try {
      await env.DB.prepare("UPDATE data_dumps SET status = 'processing' WHERE id = ?")
        .bind(dump.id)
        .run();

      const bundle = dump.type === "full"
        ? await buildFullExport(env.DB, dump.user_id)
        : await buildDailyExport(env.DB, dump.user_id);

      await env.R2_BUCKET.put(dumpObjectKey(dump.user_id, dump.id), JSON.stringify(bundle));

      await env.DB.prepare(
        `UPDATE data_dumps
            SET status = 'completed', download_url = ?, expires_at = datetime('now', '+7 days')
          WHERE id = ?`,
      )
        .bind(downloadPath(env, dump.id), dump.id)
        .run();
    } catch (err) {
      console.error(`data dump build failed id=${dump.id}:`, err);
      await env.DB.prepare("UPDATE data_dumps SET status = 'failed' WHERE id = ?")
        .bind(dump.id)
        .run();
    }
  }
}

/** Delete expired dumps' R2 objects and mark the rows `expired`. */
export async function purgeExpiredDumps(env: Env): Promise<void> {
  if (!env.R2_BUCKET) return;

  const { results } = await env.DB.prepare(
    `SELECT id, user_id FROM data_dumps
      WHERE status = 'completed' AND expires_at IS NOT NULL AND expires_at < datetime('now')`,
  ).all<{ id: string; user_id: string }>();

  for (const dump of results) {
    try {
      await env.R2_BUCKET.delete(dumpObjectKey(dump.user_id, dump.id));
    } catch (err) {
      console.error(`data dump purge failed id=${dump.id}:`, err);
    }
    await env.DB.prepare("UPDATE data_dumps SET status = 'expired', download_url = NULL WHERE id = ?")
      .bind(dump.id)
      .run();
  }
}
