import { getDateForTimestamp } from "../utils/time-format";

type HeartbeatForAggregation = {
  user_id: string;
  time: number;
  project: string | null;
  language: string | null;
  editor: string | null;
  operating_system: string | null;
  category: string | null;
  branch: string | null;
  machine: string | null;
};

type SummaryTuple = {
  userId: string;
  date: string;
  project: string;
  language: string;
  editor: string;
  operatingSystem: string;
  category: string;
  branch: string;
  machine: string;
  seconds: number;
};

const DEFAULT_TIMEOUT = 15 * 60; // 15 minutes in seconds
const MAX_USER_TIMEOUT = 60 * 60; // 60 minutes — max allowed by validation
const HEARTBEAT_LIMIT = 5000;

async function getLastAggregatedAt(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT value FROM meta WHERE key = 'last_aggregated_at'")
    .first<{ value: string }>();
  return row ? Number(row.value) : 0;
}

type UserSettings = { timeout: number; timezone: string };

async function getUserSettings(
  db: D1Database,
  userIds: string[],
): Promise<Map<string, UserSettings>> {
  if (userIds.length === 0) return new Map();
  const placeholders = userIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT id, timeout, timezone FROM users WHERE id IN (${placeholders})`)
    .bind(...userIds)
    .all<{ id: string; timeout: number; timezone: string }>();
  const map = new Map<string, UserSettings>();
  for (const row of results) {
    map.set(row.id, {
      timeout: row.timeout * 60, // stored as minutes, convert to seconds
      timezone: row.timezone,
    });
  }
  return map;
}

function computeDurations(
  heartbeats: HeartbeatForAggregation[],
  userSettings: Map<string, UserSettings>,
  lastAggregatedAt: number,
): Map<string, SummaryTuple> {
  const result = new Map<string, SummaryTuple>();

  // Group heartbeats by user_id
  const byUser = new Map<string, HeartbeatForAggregation[]>();
  for (const hb of heartbeats) {
    const list = byUser.get(hb.user_id);
    if (list) {
      list.push(hb);
    } else {
      byUser.set(hb.user_id, [hb]);
    }
  }

  for (const [userId, userHeartbeats] of byUser) {
    const settings = userSettings.get(userId);
    const timeout = settings?.timeout ?? DEFAULT_TIMEOUT;
    const tz = settings?.timezone ?? "UTC";

    // Already sorted by time ASC from the query, but ensure order
    for (let i = 1; i < userHeartbeats.length; i++) {
      const prev = userHeartbeats[i - 1];
      const curr = userHeartbeats[i];
      const gap = curr.time - prev.time;

      // Only generate durations for heartbeats after lastAggregatedAt
      if (curr.time <= lastAggregatedAt) continue;

      if (gap > timeout || gap <= 0) continue;

      // Attribute the interval [prev.time, curr.time) to prev's context
      // Use empty string sentinel for NULL dimensions
      const date = getDateForTimestamp(prev.time, tz);
      const project = prev.project ?? "";
      const language = prev.language ?? "";
      const editor = prev.editor ?? "";
      const os = prev.operating_system ?? "";
      const category = prev.category ?? "";
      const branch = prev.branch ?? "";
      const machine = prev.machine ?? "";

      const key = `${userId}|${date}|${project}|${language}|${editor}|${os}|${category}|${branch}|${machine}`;

      const existing = result.get(key);
      if (existing) {
        existing.seconds += gap;
      } else {
        result.set(key, {
          userId,
          date,
          project,
          language,
          editor,
          operatingSystem: os,
          category,
          branch,
          machine,
          seconds: gap,
        });
      }
    }
  }

  return result;
}

export async function aggregateHeartbeats(db: D1Database): Promise<void> {
  const lastAggregatedAt = await getLastAggregatedAt(db);

  // Use the max allowed timeout (60min) for lookback to cover all users
  const lookbackTime = lastAggregatedAt > 0 ? lastAggregatedAt - MAX_USER_TIMEOUT : 0;

  // 1. Fetch exactly 1 lookback heartbeat per user (latest before cursor)
  // SQLite guarantees bare columns match the row containing MAX()
  const { results: lookbackHeartbeats } = lastAggregatedAt > 0
    ? await db
        .prepare(
          `SELECT user_id, max(time) as time, project, branch, language, editor,
                  operating_system, category, machine
           FROM heartbeats
           WHERE time > ? AND time <= ?
           GROUP BY user_id`,
        )
        .bind(lookbackTime, lastAggregatedAt)
        .all<HeartbeatForAggregation>()
    : { results: [] as HeartbeatForAggregation[] };

  // 2. Fetch new heartbeats strictly after cursor
  const { results: newHeartbeats } = await db
    .prepare(
      `SELECT user_id, time, project, branch, language, editor,
              operating_system, category, machine
       FROM heartbeats
       WHERE time > ?
       ORDER BY time ASC
       LIMIT ?`,
    )
    .bind(lastAggregatedAt, HEARTBEAT_LIMIT)
    .all<HeartbeatForAggregation>();

  if (newHeartbeats.length === 0) return;

  // maxTime guaranteed to advance because all newHeartbeats > lastAggregatedAt
  let maxTime = lastAggregatedAt;
  for (const hb of newHeartbeats) {
    if (hb.time > maxTime) maxTime = hb.time;
  }

  // Combine: lookback heartbeats precede new ones chronologically per-user
  const heartbeats = [...lookbackHeartbeats, ...newHeartbeats];

  // Fetch settings only for users present in this batch
  const uniqueUserIds = [...new Set(heartbeats.map((hb) => hb.user_id))];
  const userSettings = await getUserSettings(db, uniqueUserIds);

  const durations = computeDurations(heartbeats, userSettings, lastAggregatedAt);

  // Build batch: all UPSERTs + meta update
  const statements: D1PreparedStatement[] = [];

  const upsertSql = `INSERT INTO summaries (user_id, date, project, language, editor, operating_system, category, branch, machine, total_seconds)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (user_id, date, project, language, editor, operating_system, category, branch, machine)
DO UPDATE SET total_seconds = total_seconds + excluded.total_seconds`;

  for (const tuple of durations.values()) {
    statements.push(
      db.prepare(upsertSql).bind(
        tuple.userId,
        tuple.date,
        tuple.project,
        tuple.language,
        tuple.editor,
        tuple.operatingSystem,
        tuple.category,
        tuple.branch,
        tuple.machine,
        Math.round(tuple.seconds),
      ),
    );
  }

  // Update cursor atomically with the UPSERTs
  statements.push(
    db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('last_aggregated_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .bind(String(maxTime)),
  );

  try {
    await db.batch(statements);
  } catch (error) {
    console.error("aggregateHeartbeats: failed to persist aggregated summaries");
    throw error;
  }
}
