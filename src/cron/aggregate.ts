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
const HEARTBEAT_LIMIT = 5000;

async function getLastAggregatedAt(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT value FROM meta WHERE key = 'last_aggregated_at'")
    .first<{ value: string }>();
  return row ? Number(row.value) : 0;
}

async function getUserTimeouts(
  db: D1Database,
): Promise<Map<string, number>> {
  const { results } = await db
    .prepare("SELECT id, timeout FROM users")
    .all<{ id: string; timeout: number }>();
  const map = new Map<string, number>();
  for (const row of results) {
    map.set(row.id, row.timeout * 60); // stored as minutes, convert to seconds
  }
  return map;
}

function computeDurations(
  heartbeats: HeartbeatForAggregation[],
  timeouts: Map<string, number>,
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
    const timeout = timeouts.get(userId) ?? DEFAULT_TIMEOUT;

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
      const date = new Date(prev.time * 1000).toISOString().slice(0, 10);
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
  const timeouts = await getUserTimeouts(db);

  // Find the maximum timeout for lookback window
  let maxTimeout = DEFAULT_TIMEOUT;
  for (const t of timeouts.values()) {
    if (t > maxTimeout) maxTimeout = t;
  }

  const lookbackTime = lastAggregatedAt > 0 ? lastAggregatedAt - maxTimeout : 0;

  const { results: heartbeats } = await db
    .prepare(
      `SELECT user_id, time, project, branch, language, editor,
              operating_system, category, machine
       FROM heartbeats
       WHERE time > ?
       ORDER BY time ASC
       LIMIT ?`,
    )
    .bind(lookbackTime, HEARTBEAT_LIMIT)
    .all<HeartbeatForAggregation>();

  if (heartbeats.length === 0) return;

  // Find the max time among new heartbeats (those after lastAggregatedAt)
  let maxTime = lastAggregatedAt;
  for (const hb of heartbeats) {
    if (hb.time > maxTime) maxTime = hb.time;
  }

  const durations = computeDurations(heartbeats, timeouts, lastAggregatedAt);

  // Always advance cursor so we don't re-scan the same heartbeats
  if (durations.size === 0) {
    await db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('last_aggregated_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .bind(String(maxTime))
      .run();
    return;
  }

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
