/**
 * Builds the JSON export bundle for a data dump (Issue #102), read from D1 and
 * scoped to one user. Stored as a single object in R2.
 *
 * Secrets (api_key_hash, OAuth tokens) are never selected — only the user's
 * own profile + activity data.
 */

/** R2 object key for a dump. Shared by the cron writer and the download route. */
export function dumpObjectKey(userId: string, dumpId: string): string {
  return `dumps/${userId}/${dumpId}.json`;
}

// Explicit safe column list — never includes api_key_hash.
const USER_COLUMNS =
  "id, username, email, display_name, photo, bio, city, timezone, timeout, " +
  "email_verified, is_hireable, github_username, twitter_username, website, created_at, modified_at";

const SUMMARY_COLUMNS =
  "date, project, language, editor, operating_system, category, branch, machine, total_seconds";

export interface ExportBundle {
  user: Record<string, unknown> | null;
  summaries: unknown[];
  daily?: { date: string; total_seconds: number }[];
  heartbeats?: unknown[];
}

async function getUser(db: D1Database, userId: string): Promise<Record<string, unknown> | null> {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(userId).first();
}

async function getSummaries(db: D1Database, userId: string): Promise<unknown[]> {
  const { results } = await db
    .prepare(`SELECT ${SUMMARY_COLUMNS} FROM summaries WHERE user_id = ? ORDER BY date ASC`)
    .bind(userId)
    .all();
  return results;
}

async function getDaily(db: D1Database, userId: string): Promise<{ date: string; total_seconds: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT date, SUM(total_seconds) AS total_seconds FROM summaries
        WHERE user_id = ? GROUP BY date ORDER BY date ASC`,
    )
    .bind(userId)
    .all<{ date: string; total_seconds: number }>();
  return results;
}

async function getHeartbeats(db: D1Database, userId: string): Promise<unknown[]> {
  const { results } = await db
    .prepare(`SELECT * FROM heartbeats WHERE user_id = ? ORDER BY time ASC`)
    .bind(userId)
    .all();
  return results;
}

/** `daily` export: profile + per-day aggregated summary buckets. */
export async function buildDailyExport(db: D1Database, userId: string): Promise<ExportBundle> {
  return {
    user: await getUser(db, userId),
    summaries: await getSummaries(db, userId),
  };
}

/** `full` export: profile + summaries + per-day totals + raw heartbeats. */
export async function buildFullExport(db: D1Database, userId: string): Promise<ExportBundle> {
  return {
    user: await getUser(db, userId),
    summaries: await getSummaries(db, userId),
    daily: await getDaily(db, userId),
    heartbeats: await getHeartbeats(db, userId),
  };
}
