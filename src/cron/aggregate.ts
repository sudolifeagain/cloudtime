import { getDateForTimestamp, getHourForTimestamp } from "../utils/time-format";
import { sessionGapSeconds } from "../utils/session-gap";

export type HeartbeatForAggregation = {
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

export type HourlyTuple = {
  userId: string;
  date: string;
  hour: number;
  seconds: number;
};

export type ComputedDurations = {
  daily: Map<string, SummaryTuple>;
  hourly: Map<string, HourlyTuple>;
};

/**
 * AI telemetry columns read alongside the base aggregation fields for the
 * `ai_daily_usage` rollup (Issue #200). `user_agent_id` is only an FK — the
 * agent label lives in `user_agents` and is resolved via {@link getAgentLabels}.
 */
export type AiTelemetryFields = {
  user_agent_id: string | null;
  ai_provider: string | null;
  ai_model: string | null;
  ai_prompt_length: number | null;
  ai_input_tokens: number | null;
  ai_output_tokens: number | null;
  ai_cached_input_tokens: number | null;
  ai_reasoning_output_tokens: number | null;
  ai_cache_write_tokens: number | null;
  ai_cache_read_tokens: number | null;
};

export type AiHeartbeatForAggregation = HeartbeatForAggregation & AiTelemetryFields;

/** One `ai_daily_usage` rollup bucket accumulated in-memory before the UPSERT. */
export type AiUsageTuple = {
  userId: string;
  day: string;
  provider: string;
  model: string;
  agent: string;
  project: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  promptLengthTotal: number;
  promptLengthCount: number;
  heartbeatCount: number;
};

const DEFAULT_TIMEOUT = 15 * 60; // 15 minutes in seconds
export const MAX_USER_TIMEOUT = 60 * 60; // 60 minutes - max allowed by validation
export const HEARTBEAT_LIMIT = 5000;

export async function getLastAggregatedAt(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT value FROM meta WHERE key = 'last_aggregated_at'")
    .first<{ value: string }>();
  return row ? Number(row.value) : 0;
}

type UserSettings = { timeout: number; timezone: string };

const BIND_CHUNK_SIZE = 100;

export async function getUserSettings(
  db: D1Database,
  userIds: string[],
): Promise<Map<string, UserSettings>> {
  const map = new Map<string, UserSettings>();
  if (userIds.length === 0) return map;

  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < userIds.length; i += BIND_CHUNK_SIZE) {
    const chunk = userIds.slice(i, i + BIND_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    stmts.push(
      db.prepare(`SELECT id, timeout, timezone FROM users WHERE id IN (${placeholders})`)
        .bind(...chunk),
    );
  }

  const batchResults = await db.batch<{ id: string; timeout: number; timezone: string }>(stmts);
  for (const response of batchResults) {
    for (const row of response.results) {
      map.set(row.id, {
        timeout: row.timeout * 60, // stored as minutes, convert to seconds
        timezone: row.timezone,
      });
    }
  }
  return map;
}

/**
 * Resolve the `agent` label for the AI usage rollup from `user_agents`, keyed by
 * the distinct `user_agent_id`s in the batch (the `getUserSettings` precedent).
 * The label is the stored `editor`/plugin identifier; rows with a null editor or
 * an id absent from `user_agents` are simply omitted (the caller falls back to
 * `unknown`). Batched in chunks of {@link BIND_CHUNK_SIZE} to stay under SQLite's
 * bound-variable limit.
 */
export async function getAgentLabels(
  db: D1Database,
  userAgentIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (userAgentIds.length === 0) return map;

  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < userAgentIds.length; i += BIND_CHUNK_SIZE) {
    const chunk = userAgentIds.slice(i, i + BIND_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    stmts.push(
      db.prepare(`SELECT id, editor FROM user_agents WHERE id IN (${placeholders})`).bind(...chunk),
    );
  }

  const batchResults = await db.batch<{ id: string; editor: string | null }>(stmts);
  for (const response of batchResults) {
    for (const row of response.results) {
      if (row.editor) map.set(row.id, row.editor);
    }
  }
  return map;
}

/** Priced token columns; presence of any one makes an `ai coding` row contribute. */
const AI_PRICED_TOKEN_FIELDS = [
  "ai_input_tokens",
  "ai_output_tokens",
  "ai_cached_input_tokens",
  "ai_reasoning_output_tokens",
  "ai_cache_write_tokens",
  "ai_cache_read_tokens",
] as const;

/**
 * A contributing heartbeat (FR-026): `category = 'ai coding'` carrying at least
 * one priced token field (presence, not value — `ai_input_tokens: 0` qualifies).
 * A prompt-length-only heartbeat creates no rollup bucket.
 */
function isContributingAi(hb: AiHeartbeatForAggregation): boolean {
  if (hb.category !== "ai coding") return false;
  return AI_PRICED_TOKEN_FIELDS.some((f) => hb[f] != null);
}

/**
 * Build the incremental `ai_daily_usage` rollup from the NEW heartbeats only
 * (never the prepended lookback rows, or their tokens re-add on every run). Each
 * bucket's `day` is keyed by the heartbeat's OWN `time` in the fixed aggregation
 * timezone (the owner's profile tz) — not `prev.time`, which is the summaries
 * duration-interval key and would misattribute a token heartbeat across midnight.
 * `provider`/`model` fall back to `unknown`; `agent` is the resolved user-agent
 * label (else `unknown`); a null `project` is coalesced to the `''` sentinel so
 * the unique index dedups exactly.
 */
export function computeAiDailyUsage(
  heartbeats: AiHeartbeatForAggregation[],
  userSettings: Map<string, UserSettings>,
  agentLabels: Map<string, string>,
): Map<string, AiUsageTuple> {
  const result = new Map<string, AiUsageTuple>();
  for (const hb of heartbeats) {
    if (!isContributingAi(hb)) continue;
    const tz = userSettings.get(hb.user_id)?.timezone ?? "UTC";
    const day = getDateForTimestamp(hb.time, tz);
    const provider = hb.ai_provider ?? "unknown";
    const model = hb.ai_model ?? "unknown";
    const agent = (hb.user_agent_id ? agentLabels.get(hb.user_agent_id) : undefined) ?? "unknown";
    const project = hb.project ?? "";

    // Pipe-joined key mirrors the summaries pass (aggregate.ts computeDurations);
    // the ai_daily_usage unique index is the authoritative dedup on write.
    const key = `${hb.user_id}|${day}|${provider}|${model}|${agent}|${project}`;
    let tuple = result.get(key);
    if (!tuple) {
      tuple = {
        userId: hb.user_id,
        day,
        provider,
        model,
        agent,
        project,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        promptLengthTotal: 0,
        promptLengthCount: 0,
        heartbeatCount: 0,
      };
      result.set(key, tuple);
    }
    tuple.inputTokens += hb.ai_input_tokens ?? 0;
    tuple.outputTokens += hb.ai_output_tokens ?? 0;
    tuple.cachedInputTokens += hb.ai_cached_input_tokens ?? 0;
    tuple.reasoningOutputTokens += hb.ai_reasoning_output_tokens ?? 0;
    tuple.cacheWriteTokens += hb.ai_cache_write_tokens ?? 0;
    tuple.cacheReadTokens += hb.ai_cache_read_tokens ?? 0;
    if (hb.ai_prompt_length != null) {
      tuple.promptLengthTotal += hb.ai_prompt_length;
      tuple.promptLengthCount += 1;
    }
    tuple.heartbeatCount += 1;
  }
  return result;
}

export function computeDurations(
  heartbeats: HeartbeatForAggregation[],
  userSettings: Map<string, UserSettings>,
  lastAggregatedAt: number,
  shouldProcessHeartbeat: (heartbeat: HeartbeatForAggregation) => boolean = (heartbeat) =>
    heartbeat.time > lastAggregatedAt,
): ComputedDurations {
  const result = new Map<string, SummaryTuple>();
  // Hour-of-day aggregate (Issue #134), bucketed in the same walk so a single
  // heartbeat scan feeds both the daily and hourly summaries.
  const hourly = new Map<string, HourlyTuple>();

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

      // Only generate durations for heartbeats after the caller's cursor.
      if (!shouldProcessHeartbeat(curr)) continue;

      // Shared per-pair idle/timeout rule (spec 145 FR-005); 0 == does not count.
      const gap = sessionGapSeconds(prev.time, curr.time, timeout);
      if (gap === 0) continue;

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

      // Attribute the same interval to prev's hour-of-day (Issue #134).
      const hour = getHourForTimestamp(prev.time, tz);
      const hourKey = `${userId}|${date}|${hour}`;
      const existingHour = hourly.get(hourKey);
      if (existingHour) {
        existingHour.seconds += gap;
      } else {
        hourly.set(hourKey, { userId, date, hour, seconds: gap });
      }
    }
  }

  return { daily: result, hourly };
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

  // 2. Fetch new heartbeats strictly after cursor. Also reads the AI telemetry
  // columns and user_agent_id (Issue #200) so the ai_daily_usage rollup is built
  // from the same single heartbeat scan; the lookback rows are duration-only and
  // never feed the AI sums.
  const { results: newHeartbeats } = await db
    .prepare(
      `SELECT user_id, time, project, branch, language, editor,
              operating_system, category, machine, user_agent_id,
              ai_provider, ai_model, ai_prompt_length, ai_input_tokens,
              ai_output_tokens, ai_cached_input_tokens, ai_reasoning_output_tokens,
              ai_cache_write_tokens, ai_cache_read_tokens
       FROM heartbeats
       WHERE time > ?
       ORDER BY time ASC
       LIMIT ?`,
    )
    .bind(lastAggregatedAt, HEARTBEAT_LIMIT)
    .all<AiHeartbeatForAggregation>();

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

  const { daily, hourly } = computeDurations(heartbeats, userSettings, lastAggregatedAt);

  // Build batch: all UPSERTs + meta update
  const statements: D1PreparedStatement[] = [];

  const upsertSql = `INSERT INTO summaries (user_id, date, project, language, editor, operating_system, category, branch, machine, total_seconds)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (user_id, date, project, language, editor, operating_system, category, branch, machine)
DO UPDATE SET total_seconds = total_seconds + excluded.total_seconds`;

  for (const tuple of daily.values()) {
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

  // Hour-of-day aggregate (Issue #134), UPSERTed in the same batch so both
  // aggregates and the cursor advance atomically off one heartbeat scan.
  const hourlyUpsertSql = `INSERT INTO hourly_summaries (user_id, date, hour, total_seconds)
VALUES (?, ?, ?, ?)
ON CONFLICT (user_id, date, hour)
DO UPDATE SET total_seconds = total_seconds + excluded.total_seconds`;

  for (const tuple of hourly.values()) {
    statements.push(
      db.prepare(hourlyUpsertSql).bind(
        tuple.userId,
        tuple.date,
        tuple.hour,
        Math.round(tuple.seconds),
      ),
    );
  }

  // AI daily usage rollup (Issue #200). Summed ONLY from newHeartbeats (never the
  // lookback rows, or their tokens would re-add every run); the agent label comes
  // from user_agents, resolved by a batched lookup keyed on the distinct
  // user_agent_ids. UPSERTed into the SAME batch as the cursor advance below so
  // the rollup and watermark move atomically (no double-count, no dropped rows).
  const aiAgentIds = [
    ...new Set(
      newHeartbeats
        .map((hb) => hb.user_agent_id)
        .filter((id): id is string => id != null),
    ),
  ];
  const agentLabels = await getAgentLabels(db, aiAgentIds);
  const aiDaily = computeAiDailyUsage(newHeartbeats, userSettings, agentLabels);

  const aiUpsertSql = `INSERT INTO ai_daily_usage
  (user_id, day, provider, model, agent, project,
   input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens,
   cache_write_tokens, cache_read_tokens, prompt_length_total, prompt_length_count,
   heartbeat_count, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
ON CONFLICT (user_id, day, provider, model, agent, project)
DO UPDATE SET
  input_tokens = input_tokens + excluded.input_tokens,
  output_tokens = output_tokens + excluded.output_tokens,
  cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
  reasoning_output_tokens = reasoning_output_tokens + excluded.reasoning_output_tokens,
  cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
  cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
  prompt_length_total = prompt_length_total + excluded.prompt_length_total,
  prompt_length_count = prompt_length_count + excluded.prompt_length_count,
  heartbeat_count = heartbeat_count + excluded.heartbeat_count,
  updated_at = datetime('now')`;

  for (const tuple of aiDaily.values()) {
    statements.push(
      db.prepare(aiUpsertSql).bind(
        tuple.userId,
        tuple.day,
        tuple.provider,
        tuple.model,
        tuple.agent,
        tuple.project,
        tuple.inputTokens,
        tuple.outputTokens,
        tuple.cachedInputTokens,
        tuple.reasoningOutputTokens,
        tuple.cacheWriteTokens,
        tuple.cacheReadTokens,
        tuple.promptLengthTotal,
        tuple.promptLengthCount,
        tuple.heartbeatCount,
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
