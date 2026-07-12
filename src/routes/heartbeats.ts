import { Hono } from "hono";
import type { AuthEnv } from "../types";
import type { components } from "../types/generated";
import { authMiddleware, getUserTimeout, getUserTimezone } from "../middleware/auth";
import { getEpochBoundsForDate } from "../utils/time-format";
import { resolveUserAgentId, deriveAiIdentity, type AiIdentity } from "../utils/user-agent";
import { applyRules, loadRules } from "../utils/custom-rules";
import { INPUT_LIMITS, tooLong, truncateTo } from "../utils/input-limits";
import { machineUpsertStmt } from "../utils/machine";

type HeartbeatInput = components["schemas"]["HeartbeatInput"];
type Heartbeat = components["schemas"]["Heartbeat"];
type HeartbeatBulkItem = components["schemas"]["HeartbeatBulkItem"];

// D1 row representation (is_write is integer, created_at may be non-ISO)
type HeartbeatRow = Omit<Heartbeat, "is_write" | "created_at"> & {
  is_write: number;
  created_at: string;
};

const VALID_TYPES = new Set(["file", "app", "domain", "url", "event"]);
const VALID_CATEGORIES = new Set([
  "coding", "building", "indexing", "debugging", "browsing",
  "running tests", "writing tests", "manual testing", "writing docs",
  "communicating", "code reviewing", "notes", "researching", "learning",
  "designing", "ai coding", "advising", "meeting", "planning",
  "supporting", "translating",
]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// AI telemetry token/length fields are non-negative integers bounded to keep
// cost accumulation within a safe numeric range and reject garbage magnitudes
// (Issue #200; mirrors the OpenAPI minimum/maximum on HeartbeatInput).
const AI_TOKEN_MAX = 1_000_000_000;
const AI_TOKEN_FIELDS = [
  "ai_prompt_length",
  "ai_input_tokens",
  "ai_output_tokens",
  "ai_cached_input_tokens",
  "ai_reasoning_output_tokens",
  "ai_cache_write_tokens",
  "ai_cache_read_tokens",
] as const;

function parseDateString(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  // Reject dates that normalize to a different day (e.g. Feb 31 → Mar 3)
  return (
    utc.getUTCFullYear() === y &&
    utc.getUTCMonth() === m - 1 &&
    utc.getUTCDate() === d
  );
}

const INSERT_HEARTBEAT_SQL = `INSERT INTO heartbeats (id, user_id, entity, type, time, category, project, project_root_count, branch, language, dependencies, lines, ai_line_changes, human_line_changes, ai_session, ai_subscription_plan, ai_prompt_length, ai_input_tokens, ai_output_tokens, ai_cached_input_tokens, ai_reasoning_output_tokens, ai_cache_write_tokens, ai_cache_read_tokens, ai_provider, ai_model, lineno, cursorpos, is_write, editor, operating_system, machine, user_agent_id, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const UPSERT_PROJECT_SQL = `INSERT INTO user_projects (user_id, project, first_heartbeat_at, last_heartbeat_at)
VALUES (?, ?, ?, ?)
ON CONFLICT (user_id, project) DO UPDATE SET
  first_heartbeat_at = MIN(first_heartbeat_at, excluded.first_heartbeat_at),
  last_heartbeat_at = MAX(last_heartbeat_at, excluded.last_heartbeat_at)`;

function bindHeartbeatParams(
  stmt: D1PreparedStatement,
  id: string,
  userId: string,
  input: HeartbeatInput,
  machine: string | undefined,
  userAgentId: string | null,
  now: string,
  derivedAi?: AiIdentity,
): D1PreparedStatement {
  return stmt.bind(
    id, userId, input.entity, input.type, input.time,
    input.category ?? null, input.project ?? null, input.project_root_count ?? null,
    input.branch ?? null, input.language ?? null, normalizeDependencies(input.dependencies),
    input.lines ?? null, input.ai_line_changes ?? null, input.human_line_changes ?? null,
    input.ai_session ?? null, input.ai_subscription_plan ?? null,
    input.ai_prompt_length ?? null, input.ai_input_tokens ?? null,
    input.ai_output_tokens ?? null, input.ai_cached_input_tokens ?? null,
    input.ai_reasoning_output_tokens ?? null, input.ai_cache_write_tokens ?? null,
    input.ai_cache_read_tokens ?? null,
    input.ai_provider ?? derivedAi?.provider ?? null,
    input.ai_model ?? derivedAi?.model ?? null,
    input.lineno ?? null, input.cursorpos ?? null, input.is_write ? 1 : 0,
    input.editor ?? null, input.operating_system ?? null,
    machine ?? null,
    userAgentId,
    now
  );
}

/**
 * For an `ai coding` heartbeat whose client did not populate `ai_provider` /
 * `ai_model`, derive them from the User-Agent (Issue #200). Compatible AI
 * plugins carry the model/provider in the User-Agent rather than the heartbeat
 * body, which would otherwise leave the usage rollup bucketed as `unknown`.
 * Returns undefined when nothing needs deriving so the existing bind path is
 * untouched.
 */
function deriveAiForHeartbeat(
  input: HeartbeatInput,
  userAgent: string | undefined,
): AiIdentity | undefined {
  if (input.category !== "ai coding") return undefined;
  if (input.ai_provider != null && input.ai_model != null) return undefined;
  if (!userAgent) return undefined;
  return deriveAiIdentity(userAgent);
}

const heartbeats = new Hono<AuthEnv>();

heartbeats.use("/heartbeats", authMiddleware);
heartbeats.use("/heartbeats/*", authMiddleware);
heartbeats.use("/heartbeats.bulk", authMiddleware);

// GET /heartbeats?date=YYYY-MM-DD
// `date` is interpreted as the user's local calendar day.
heartbeats.get("/heartbeats", async (c) => {
  const date = c.req.query("date");
  if (!date) {
    return c.json({ error: "date query parameter is required" }, 400);
  }
  if (!parseDateString(date)) {
    return c.json({ error: "Invalid date" }, 400);
  }

  const tz = await getUserTimezone(c);
  const { start, end } = getEpochBoundsForDate(date, tz);

  // users.timeout is stored in minutes; convert to seconds for time-delta math.
  const timeoutMinutes = await getUserTimeout(c);
  const sessionTimeoutSeconds = timeoutMinutes * 60;

  const userId = c.get("userId");

  try {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM heartbeats WHERE user_id = ? AND time >= ? AND time < ? ORDER BY time ASC"
    )
      .bind(userId, start, end)
      .all<HeartbeatRow>();

    const heartbeats = results.map(rowToHeartbeat);
    // Enrich with start/end/timezone (computed at query time)
    const enriched = heartbeats.map((hb, i) => {
      const startTime = hb.time;
      const nextTime = i < heartbeats.length - 1 ? heartbeats[i + 1].time : undefined;
      const endTime = (nextTime !== undefined && nextTime - startTime <= sessionTimeoutSeconds)
        ? nextTime
        : startTime;
      return { ...hb, start: startTime, end: endTime, timezone: tz };
    });
    return c.json({ data: enriched });
  } catch (err) {
    console.error("GET /heartbeats error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// POST /heartbeats (single)
heartbeats.post("/heartbeats", async (c) => {
  const userId = c.get("userId");

  let input: HeartbeatInput;
  try {
    input = await c.req.json<HeartbeatInput>();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const err = validateHeartbeatInput(input);
  if (err) {
    return c.json({ error: err }, 400);
  }

  // Header-derived ambient values truncate to the contract caps instead of
  // failing the heartbeat (Issue #158, research R-5); body values were
  // validated above. The User-Agent value is capped inside resolveUserAgentId.
  const rawHeaderMachine = c.req.header("X-Machine-Name");
  const machine = input.machine
    ?? (rawHeaderMachine !== undefined ? truncateTo(rawHeaderMachine, INPUT_LIMITS.name) : undefined);
  const userAgent = input.user_agent ?? c.req.header("User-Agent") ?? undefined;
  const ip = c.req.header("CF-Connecting-IP") ?? null;

  try {
    // Apply the user's custom rules before persisting (Issue #101). A `change`
    // rewrites a dimension in place; a `hide` drops the heartbeat. Hidden
    // heartbeats still get a success-shaped response so the caller cannot tell
    // which were dropped.
    const rules = await loadRules(c.env, userId);
    if (applyRules(input, rules) === null) {
      return c.json({ data: buildHeartbeatResponse(crypto.randomUUID(), userId, input, machine, null) }, 201);
    }
    const heartbeat = await insertHeartbeat(c.env.DB, userId, input, machine, userAgent, ip);
    return c.json({ data: heartbeat }, 201);
  } catch (err) {
    console.error("POST /heartbeats error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// POST /heartbeats.bulk
heartbeats.post("/heartbeats.bulk", async (c) => {
  const userId = c.get("userId");

  let inputs: HeartbeatInput[];
  try {
    inputs = await c.req.json<HeartbeatInput[]>();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  if (!Array.isArray(inputs) || inputs.length === 0) {
    return c.json({ error: "Request body must be a non-empty array" }, 400);
  }
  if (inputs.length > 25) {
    return c.json({ error: "Maximum 25 heartbeats per request" }, 400);
  }

  // Resolve machine/user_agent: body field > header > undefined.
  // Header values truncate to the contract caps (Issue #158, research R-5);
  // the User-Agent value is capped inside resolveUserAgentId.
  const rawHeaderMachine = c.req.header("X-Machine-Name");
  const headerMachine = rawHeaderMachine !== undefined
    ? truncateTo(rawHeaderMachine, INPUT_LIMITS.name)
    : undefined;
  const headerUserAgent = c.req.header("User-Agent") ?? undefined;
  const ip = c.req.header("CF-Connecting-IP") ?? null;
  const now = new Date().toISOString();

  // Per-item validation
  const validationErrors: (string | null)[] = inputs.map((input) => validateHeartbeatInput(input));
  const ids = inputs.map(() => crypto.randomUUID());

  // Apply the user's custom rules before anything is persisted (Issue #101).
  // `change` rewrites dimensions on inputs[i] in place; `hide` flags the item
  // so it is excluded from the batch. Rules are loaded once per request.
  const rules = await loadRules(c.env, userId);
  const hidden: boolean[] = new Array(inputs.length).fill(false);
  for (let i = 0; i < inputs.length; i++) {
    if (validationErrors[i]) continue;
    if (applyRules(inputs[i], rules) === null) {
      hidden[i] = true;
    }
  }

  // Resolve every distinct User-Agent value once before the heartbeat batch,
  // so a 25-item bulk POST issues at most a handful of upserts instead of one
  // per heartbeat (Issue #99). Hidden heartbeats are skipped so they leave no
  // user_agents trace.
  const userAgentCache = new Map<string, string>();
  const userAgentIds: (string | null)[] = new Array(inputs.length).fill(null);
  for (let i = 0; i < inputs.length; i++) {
    if (validationErrors[i] || hidden[i]) continue;
    const ua = inputs[i].user_agent ?? headerUserAgent;
    userAgentIds[i] = await resolveUserAgentId(c.env.DB, userId, ua ?? null, userAgentCache);
  }

  // Build insert statements only for valid, non-hidden heartbeats
  const stmts: D1PreparedStatement[] = [];
  const projectTimes = new Map<string, { min: number; max: number }>();
  const machineValues = new Set<string>();

  for (let i = 0; i < inputs.length; i++) {
    if (validationErrors[i] || hidden[i]) continue;
    const input = inputs[i];
    const machine = input.machine ?? headerMachine;
    const derivedAi = deriveAiForHeartbeat(input, input.user_agent ?? headerUserAgent);
    stmts.push(
      bindHeartbeatParams(c.env.DB.prepare(INSERT_HEARTBEAT_SQL), ids[i], userId, input, machine, userAgentIds[i], now, derivedAi)
    );
    if (input.project) {
      const existing = projectTimes.get(input.project);
      if (existing) {
        existing.min = Math.min(existing.min, input.time);
        existing.max = Math.max(existing.max, input.time);
      } else {
        projectTimes.set(input.project, { min: input.time, max: input.time });
      }
    }
    if (machine) {
      machineValues.add(machine);
    }
  }
  for (const [project, times] of projectTimes) {
    stmts.push(c.env.DB.prepare(UPSERT_PROJECT_SQL).bind(userId, project, times.min, times.max));
  }
  // Register each distinct device once (Issue #104). Appended after the
  // heartbeat inserts so the per-item batch-result mapping below is unaffected.
  for (const value of machineValues) {
    stmts.push(machineUpsertStmt(c.env.DB, userId, value, ip));
  }

  let batchResults: D1Result[] = [];
  if (stmts.length > 0) {
    try {
      batchResults = await c.env.DB.batch(stmts);
    } catch (err) {
      console.error("POST /heartbeats.bulk error:", err);
      return c.json({ error: "Internal server error" }, 500);
    }
  }

  // Map batch results back to per-input indices. Hidden items report success
  // with the same shape as a stored heartbeat so the caller cannot tell which
  // were dropped; invalid items report their error; the rest consume a batch
  // result in order.
  let batchIdx = 0;
  const responses: [HeartbeatBulkItem, number][] = inputs.map((_, i) => {
    if (validationErrors[i]) {
      return [{ data: null, error: validationErrors[i] }, 400];
    }
    if (hidden[i]) {
      return [{ data: { id: ids[i] }, error: null }, 201];
    }
    const success = batchResults[batchIdx]?.success ?? false;
    batchIdx++;
    if (!success) {
      return [{ data: null, error: "Insert failed" }, 500];
    }
    return [{ data: { id: ids[i] }, error: null }, 201];
  });

  return c.json({ responses }, 202);
});

// DELETE /heartbeats.bulk
heartbeats.delete("/heartbeats.bulk", async (c) => {
  const userId = c.get("userId");

  let body: { date: string; ids: string[] };
  try {
    body = await c.req.json<{ date: string; ids: string[] }>();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  if (!body.date || !Array.isArray(body.ids) || body.ids.length === 0) {
    return c.json({ error: "date and ids are required" }, 400);
  }
  if (body.ids.length > 100) {
    return c.json({ error: "Maximum 100 IDs per request" }, 400);
  }
  for (const id of body.ids) {
    if (typeof id !== "string" || id.length === 0) {
      return c.json({ error: "ids must be an array of non-empty strings" }, 400);
    }
  }
  if (!parseDateString(body.date)) {
    return c.json({ error: "Invalid date" }, 400);
  }

  // The `date` filter must match the GET endpoint's timezone semantics: a
  // heartbeat returned by GET /heartbeats?date=YYYY-MM-DD must also be
  // deletable by the same date string. Both use the user's profile timezone.
  const tz = await getUserTimezone(c);
  const { start: dayStart, end: dayEnd } = getEpochBoundsForDate(body.date, tz);

  try {
    const placeholders = body.ids.map(() => "?").join(", ");

    // Step 1: Get distinct projects from heartbeats being deleted
    const { results: affectedProjects } = await c.env.DB.prepare(
      `SELECT DISTINCT project FROM heartbeats WHERE user_id = ? AND time >= ? AND time < ? AND id IN (${placeholders}) AND project IS NOT NULL`
    )
      .bind(userId, dayStart, dayEnd, ...body.ids)
      .all<{ project: string }>();

    // Step 2: Delete heartbeats
    await c.env.DB.prepare(
      `DELETE FROM heartbeats WHERE user_id = ? AND time >= ? AND time < ? AND id IN (${placeholders})`
    )
      .bind(userId, dayStart, dayEnd, ...body.ids)
      .run();

    // Step 3: Update user_projects for affected projects
    // Note: Steps 1-3 are separate D1 transactions (D1 has no cross-statement
    // transactions). A concurrent insert between step 2 and 3 is benign — the
    // recalculated timestamps will include the new heartbeat, and the next
    // insert's UPSERT will correct any remaining drift.
    if (affectedProjects.length > 0) {
      // Batch query remaining heartbeats for each affected project
      const selectStmts = affectedProjects.map(({ project }) =>
        c.env.DB.prepare(
          "SELECT MIN(time) as first_hb, MAX(time) as last_hb FROM heartbeats WHERE user_id = ? AND project = ?"
        ).bind(userId, project)
      );
      const selectResults = await c.env.DB.batch(selectStmts);

      // Build update/delete statements based on results
      const updateStmts: D1PreparedStatement[] = [];
      for (let i = 0; i < affectedProjects.length; i++) {
        const project = affectedProjects[i].project;
        const raw = selectResults[i].results?.[0] as Record<string, unknown> | undefined;
        const firstHb = typeof raw?.first_hb === "number" ? raw.first_hb : null;
        const lastHb = typeof raw?.last_hb === "number" ? raw.last_hb : null;
        if (firstHb != null && lastHb != null) {
          updateStmts.push(
            c.env.DB.prepare(
              "UPDATE user_projects SET first_heartbeat_at = ?, last_heartbeat_at = ? WHERE user_id = ? AND project = ?"
            ).bind(firstHb, lastHb, userId, project)
          );
        } else {
          updateStmts.push(
            c.env.DB.prepare(
              "DELETE FROM user_projects WHERE user_id = ? AND project = ?"
            ).bind(userId, project)
          );
        }
      }
      if (updateStmts.length > 0) {
        await c.env.DB.batch(updateStmts);
      }
    }
  } catch (err) {
    console.error("DELETE /heartbeats.bulk error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }

  return c.body(null, 204);
});

// --- Helpers ---

/** Normalize dependencies to a JSON string for DB storage. */
function normalizeDependencies(deps: string | string[] | undefined): string | null {
  if (deps === undefined || deps === null) return null;
  if (Array.isArray(deps)) return JSON.stringify(deps);
  // Comma-separated string → array
  return JSON.stringify(deps.split(",").map((s) => s.trim()).filter(Boolean));
}

function validateHeartbeatInput(input: HeartbeatInput): string | null {
  if (!input || typeof input !== "object") return "must be an object";
  if (typeof input.entity !== "string" || input.entity.length === 0) return "entity is required";
  if (tooLong(input.entity, INPUT_LIMITS.entity)) {
    return `entity must be at most ${INPUT_LIMITS.entity} characters`;
  }
  if (!VALID_TYPES.has(input.type)) return `type must be one of: ${[...VALID_TYPES].join(", ")}`;
  if (typeof input.time !== "number" || !Number.isFinite(input.time)) return "time must be a valid number";
  if (input.category !== undefined && !VALID_CATEGORIES.has(input.category)) {
    return `category must be one of: ${[...VALID_CATEGORIES].join(", ")}`;
  }

  // Length caps on optional body string fields (Issue #158; values from
  // src/utils/input-limits.ts, mirroring the OpenAPI maxLength constraints).
  // Header-derived machine/user_agent values are truncated at ingestion
  // instead — these checks cover only what the client put in the body.
  const cappedFields = [
    ["project", INPUT_LIMITS.name],
    ["branch", INPUT_LIMITS.name],
    ["language", INPUT_LIMITS.name],
    ["editor", INPUT_LIMITS.name],
    ["operating_system", INPUT_LIMITS.name],
    ["machine", INPUT_LIMITS.name],
    ["user_agent", INPUT_LIMITS.userAgent],
    // AI telemetry string fields (Issue #200); stored verbatim, grouping only.
    ["ai_session", INPUT_LIMITS.name],
    ["ai_subscription_plan", INPUT_LIMITS.name],
    ["ai_provider", INPUT_LIMITS.name],
    ["ai_model", INPUT_LIMITS.name],
  ] as const;
  for (const [field, cap] of cappedFields) {
    const val = input[field];
    if (val === undefined || val === null) continue;
    if (typeof val !== "string") return `${field} must be a string`;
    if (tooLong(val, cap)) return `${field} must be at most ${cap} characters`;
  }

  // AI telemetry token/length fields: non-negative integers, bounded (#200).
  // Explicit null is treated as "not reported" (skipped), matching the capped
  // string fields above; only present numeric values are validated.
  for (const field of AI_TOKEN_FIELDS) {
    const val = input[field];
    if (val === undefined || val === null) continue;
    if (typeof val !== "number" || !Number.isInteger(val)) {
      return `${field} must be an integer`;
    }
    if (val < 0 || val > AI_TOKEN_MAX) {
      return `${field} must be between 0 and ${AI_TOKEN_MAX}`;
    }
  }

  // Validate optional numeric fields when present
  const numericFields = ["project_root_count", "lines", "ai_line_changes", "human_line_changes", "lineno", "cursorpos"] as const;
  for (const field of numericFields) {
    const val = input[field];
    if (val !== undefined && (typeof val !== "number" || !Number.isFinite(val))) {
      return `${field} must be a number`;
    }
  }

  if (input.is_write !== undefined && typeof input.is_write !== "boolean") {
    return "is_write must be a boolean";
  }

  if (input.dependencies !== undefined) {
    const isString = typeof input.dependencies === "string";
    if (!isString && !Array.isArray(input.dependencies)) {
      return "dependencies must be a string or array of strings";
    }
    if (isString && tooLong(input.dependencies as string, INPUT_LIMITS.dependenciesString)) {
      return `dependencies must be at most ${INPUT_LIMITS.dependenciesString} characters`;
    }
    // Both forms normalize to a list (see normalizeDependencies); the count
    // and per-item caps apply to that result (FR-005).
    const items = isString
      ? (input.dependencies as string).split(",").map((s) => s.trim()).filter(Boolean)
      : (input.dependencies as unknown[]);
    if (items.length > INPUT_LIMITS.dependenciesItems) {
      return `dependencies must have at most ${INPUT_LIMITS.dependenciesItems} items`;
    }
    for (const dep of items) {
      if (typeof dep !== "string") return "dependencies must be a string or array of strings";
      if (tooLong(dep, INPUT_LIMITS.dependencyName)) {
        return `each dependency must be at most ${INPUT_LIMITS.dependencyName} characters`;
      }
    }
  }

  return null;
}

async function insertHeartbeat(
  db: D1Database,
  userId: string,
  input: HeartbeatInput,
  machine: string | undefined,
  userAgent: string | undefined,
  ip: string | null = null,
): Promise<Heartbeat> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Resolve User-Agent string to a user_agents.id (Issue #99).
  // The upsert runs as a standalone statement (not inside the batch) because
  // D1.batch() does not propagate RETURNING values across statements; we need
  // the id before binding the heartbeat insert.
  const userAgentId = await resolveUserAgentId(db, userId, userAgent ?? null);
  const derivedAi = deriveAiForHeartbeat(input, userAgent);

  const stmts = [bindHeartbeatParams(db.prepare(INSERT_HEARTBEAT_SQL), id, userId, input, machine, userAgentId, now, derivedAi)];
  if (input.project) {
    stmts.push(db.prepare(UPSERT_PROJECT_SQL).bind(userId, input.project, input.time, input.time));
  }
  // Register the device in the machine_names registry (Issue #104).
  if (machine) {
    stmts.push(machineUpsertStmt(db, userId, machine, ip));
  }
  await db.batch(stmts);

  return buildHeartbeatResponse(id, userId, input, machine, userAgentId, now);
}

/**
 * Build the API response object for a heartbeat. Shared by the persisted path
 * and the `hide` path so a dropped heartbeat is indistinguishable from a
 * stored one in the response (Issue #101).
 */
function buildHeartbeatResponse(
  id: string,
  userId: string,
  input: HeartbeatInput,
  machine: string | undefined,
  userAgentId: string | null,
  now: string = new Date().toISOString(),
): Heartbeat {
  return {
    id,
    user_id: userId,
    ...input,
    is_write: input.is_write ?? false,
    machine,
    user_agent_id: userAgentId ?? undefined,
    created_at: now,
  };
}

function rowToHeartbeat(row: HeartbeatRow): Heartbeat {
  // Normalize created_at to ISO 8601 (handle legacy D1 datetime('now') format)
  const createdAt = row.created_at.includes("T")
    ? row.created_at
    : row.created_at.replace(" ", "T") + "Z";

  // Parse dependencies from JSON string back to array for API response
  let dependencies = row.dependencies;
  if (typeof dependencies === "string") {
    try {
      dependencies = JSON.parse(dependencies);
    } catch {
      // Keep as-is if not valid JSON
    }
  }

  return {
    ...row,
    dependencies,
    is_write: row.is_write === 1,
    created_at: createdAt,
  };
}

export default heartbeats;
