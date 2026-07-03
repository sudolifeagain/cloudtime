import {
  computeDurations,
  getLastAggregatedAt,
  getUserSettings,
  HEARTBEAT_LIMIT,
  MAX_USER_TIMEOUT,
  type HeartbeatForAggregation,
  type HourlyTuple,
} from "./aggregate";

const CURSOR_KEY = "hourly_backfill_cursor";
const CURSOR_ID_KEY = "hourly_backfill_cursor_id";
const COMPLETED_KEY = "hourly_backfill_completed_at";
const EARLIEST_DATE_KEY = "hourly_backfill_earliest_date";
const DATE_PAIR_CHUNK_SIZE = 50;

type BackfillHeartbeat = HeartbeatForAggregation & { id: string };

export type HourlyBackfillStatus = "waiting" | "skipped" | "processed" | "complete";

export interface HourlyBackfillResult {
  status: HourlyBackfillStatus;
  scannedHeartbeats: number;
  insertedRows: number;
  cursor: number;
  earliestDate?: string;
}

export async function backfillHourlySummaries(
  db: D1Database,
  limit = HEARTBEAT_LIMIT,
): Promise<HourlyBackfillResult> {
  if (await hasMetaKey(db, COMPLETED_KEY)) {
    return { status: "skipped", scannedHeartbeats: 0, insertedRows: 0, cursor: 0 };
  }

  const lastAggregatedAt = await getLastAggregatedAt(db);
  if (lastAggregatedAt <= 0) {
    return { status: "waiting", scannedHeartbeats: 0, insertedRows: 0, cursor: 0 };
  }

  const cursor = await getMetaNumber(db, CURSOR_KEY);
  const cursorId = await getMetaString(db, CURSOR_ID_KEY);
  const safeLimit = Math.max(1, Math.floor(limit));
  const newHeartbeats = await loadBackfillHeartbeats(db, cursor, cursorId, lastAggregatedAt, safeLimit);
  if (newHeartbeats.length === 0) {
    await db.batch([
      upsertMeta(db, CURSOR_KEY, String(lastAggregatedAt)),
      upsertMeta(db, CURSOR_ID_KEY, ""),
      upsertMeta(db, COMPLETED_KEY, new Date().toISOString()),
    ]);
    return {
      status: "complete",
      scannedHeartbeats: 0,
      insertedRows: 0,
      cursor: lastAggregatedAt,
    };
  }

  const lookbackHeartbeats = await loadLookbackHeartbeats(db, cursor, cursorId);
  const heartbeats = [...lookbackHeartbeats, ...newHeartbeats];
  const userSettings = await getUserSettings(db, [...new Set(heartbeats.map((hb) => hb.user_id))]);
  const { hourly } = computeDurations(
    heartbeats,
    userSettings,
    cursor,
    (hb) => hb.time > cursor || (hb.time === cursor && (hb as BackfillHeartbeat).id > cursorId),
  );
  const fillable = await filterTuplesForBackfillableDates(db, [...hourly.values()]);

  const lastHeartbeat = newHeartbeats.at(-1);
  if (!lastHeartbeat) {
    throw new Error("backfillHourlySummaries: expected a non-empty heartbeat batch");
  }
  const maxTime = lastHeartbeat.time;
  const complete = newHeartbeats.length < safeLimit;
  const earliestDate = minDate(fillable);

  const statements: D1PreparedStatement[] = [];
  const insertSql = `INSERT INTO hourly_summaries (user_id, date, hour, total_seconds)
VALUES (?, ?, ?, ?)
ON CONFLICT (user_id, date, hour)
DO UPDATE SET total_seconds = total_seconds + excluded.total_seconds`;

  for (const tuple of fillable) {
    statements.push(
      db.prepare(insertSql).bind(
        tuple.userId,
        tuple.date,
        tuple.hour,
        Math.round(tuple.seconds),
      ),
    );
  }
  for (const tuple of uniqueDateTuples(fillable)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO hourly_backfill_dates (user_id, date, created_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT (user_id, date) DO NOTHING`,
        )
        .bind(tuple.userId, tuple.date),
    );
  }

  statements.push(upsertMeta(db, CURSOR_KEY, String(maxTime)));
  statements.push(upsertMeta(db, CURSOR_ID_KEY, lastHeartbeat.id));
  if (earliestDate) statements.push(upsertEarliestDate(db, earliestDate));
  if (complete) statements.push(upsertMeta(db, COMPLETED_KEY, new Date().toISOString()));

  await db.batch(statements);

  return {
    status: complete ? "complete" : "processed",
    scannedHeartbeats: newHeartbeats.length,
    insertedRows: fillable.length,
    cursor: maxTime,
    earliestDate: earliestDate ?? undefined,
  };
}

async function hasMetaKey(db: D1Database, key: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS ok FROM meta WHERE key = ?").bind(key).first<{ ok: number }>();
  return row !== null;
}

async function getMetaNumber(db: D1Database, key: string): Promise<number> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
  const value = Number(row?.value ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function getMetaString(db: D1Database, key: string): Promise<string> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? "";
}

async function loadLookbackHeartbeats(
  db: D1Database,
  cursor: number,
  cursorId: string,
): Promise<BackfillHeartbeat[]> {
  if (cursor <= 0) return [];
  const lookbackTime = Math.max(0, cursor - MAX_USER_TIMEOUT);
  const cursorPredicate = cursorId
    ? "(time < ? OR (time = ? AND id <= ?))"
    : "time <= ?";
  const bindings = cursorId
    ? [lookbackTime, cursor, cursor, cursorId]
    : [lookbackTime, cursor];
  const { results } = await db
    .prepare(
      `SELECT id, user_id, time, project, branch, language, editor,
              operating_system, category, machine
       FROM (
         SELECT id, user_id, time, project, branch, language, editor,
                operating_system, category, machine,
                ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY time DESC, id DESC) AS rn
         FROM heartbeats
         WHERE time > ? AND ${cursorPredicate}
       )
       WHERE rn = 1`,
    )
    .bind(...bindings)
    .all<BackfillHeartbeat>();
  return results;
}

async function loadBackfillHeartbeats(
  db: D1Database,
  cursor: number,
  cursorId: string,
  lastAggregatedAt: number,
  limit: number,
): Promise<BackfillHeartbeat[]> {
  const { results } = await db
    .prepare(
      `SELECT id, user_id, time, project, branch, language, editor,
              operating_system, category, machine
       FROM heartbeats
       WHERE (time > ? OR (time = ? AND id > ?)) AND time <= ?
       ORDER BY time ASC, id ASC
       LIMIT ?`,
    )
    .bind(cursor, cursor, cursorId, lastAggregatedAt, limit)
    .all<BackfillHeartbeat>();
  return results;
}

async function filterTuplesForBackfillableDates(
  db: D1Database,
  tuples: HourlyTuple[],
): Promise<HourlyTuple[]> {
  const { existingDates, backfilledDates } = await loadHourlyDateState(db, tuples);
  return tuples.filter((tuple) => {
    const key = hourlyDateKey(tuple.userId, tuple.date);
    return !existingDates.has(key) || backfilledDates.has(key);
  });
}

async function loadHourlyDateState(
  db: D1Database,
  tuples: HourlyTuple[],
): Promise<{ existingDates: Set<string>; backfilledDates: Set<string> }> {
  const uniquePairs = uniqueDateTuples(tuples);
  const existingDates = new Set<string>();
  const backfilledDates = new Set<string>();

  for (let i = 0; i < uniquePairs.length; i += DATE_PAIR_CHUNK_SIZE) {
    const chunk = uniquePairs.slice(i, i + DATE_PAIR_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const clauses = chunk.map(() => "(user_id = ? AND date = ?)").join(" OR ");
    const binds = chunk.flatMap((pair) => [pair.userId, pair.date]);
    const hourly = await db
      .prepare(`SELECT DISTINCT user_id, date FROM hourly_summaries WHERE ${clauses}`)
      .bind(...binds)
      .all<{ user_id: string; date: string }>();
    for (const row of hourly.results) {
      existingDates.add(hourlyDateKey(row.user_id, row.date));
    }

    const backfilled = await db
      .prepare(`SELECT user_id, date FROM hourly_backfill_dates WHERE ${clauses}`)
      .bind(...binds)
      .all<{ user_id: string; date: string }>();
    for (const row of backfilled.results) {
      backfilledDates.add(hourlyDateKey(row.user_id, row.date));
    }
  }

  return { existingDates, backfilledDates };
}

function uniqueDateTuples(tuples: HourlyTuple[]): Array<{ userId: string; date: string }> {
  return [...new Map(tuples.map((tuple) => [
    hourlyDateKey(tuple.userId, tuple.date),
    { userId: tuple.userId, date: tuple.date },
  ])).values()];
}

function hourlyDateKey(userId: string, date: string): string {
  return `${userId}|${date}`;
}

function minDate(tuples: HourlyTuple[]): string | null {
  let earliest: string | null = null;
  for (const tuple of tuples) {
    if (!earliest || tuple.date < earliest) earliest = tuple.date;
  }
  return earliest;
}

function upsertMeta(db: D1Database, key: string, value: string): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
    .bind(key, value);
}

function upsertEarliestDate(db: D1Database, date: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET
         value = CASE WHEN value < excluded.value THEN value ELSE excluded.value END`,
    )
    .bind(EARLIEST_DATE_KEY, date);
}
