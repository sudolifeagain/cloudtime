import { Hono } from "hono";
import type { AuthEnv } from "../types";
import type { components } from "../types/generated";
import { authMiddleware, getUserTimeout, getUserTimezone } from "../middleware/auth";
import { getEpochBoundsForDate } from "../utils/time-format";
import { resolveUserAgentId } from "../utils/user-agent";

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

const INSERT_HEARTBEAT_SQL = `INSERT INTO heartbeats (id, user_id, entity, type, time, category, project, project_root_count, branch, language, dependencies, lines, ai_line_changes, human_line_changes, lineno, cursorpos, is_write, editor, operating_system, machine, user_agent_id, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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
  now: string
): D1PreparedStatement {
  return stmt.bind(
    id, userId, input.entity, input.type, input.time,
    input.category ?? null, input.project ?? null, input.project_root_count ?? null,
    input.branch ?? null, input.language ?? null, normalizeDependencies(input.dependencies),
    input.lines ?? null, input.ai_line_changes ?? null, input.human_line_changes ?? null,
    input.lineno ?? null, input.cursorpos ?? null, input.is_write ? 1 : 0,
    input.editor ?? null, input.operating_system ?? null,
    machine ?? null,
    userAgentId,
    now
  );
}

const heartbeats = new Hono<AuthEnv>();

heartbeats.use("/heartbeats", authMiddleware);
heartbeats.use("/heartbeats/*", authMiddleware);
heartbeats.use("/heartbeats.bulk", authMiddleware);

// GET /heartbeats?date=YYYY-MM-DD
// `date` is interpreted in the user's profile timezone (matches WakaTime:
// "Heartbeats will be returned from 12am until 11:59pm in user's timezone").
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

  const machine = input.machine ?? c.req.header("X-Machine-Name") ?? undefined;
  const userAgent = input.user_agent ?? c.req.header("User-Agent") ?? undefined;

  try {
    const heartbeat = await insertHeartbeat(c.env.DB, userId, input, machine, userAgent);
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

  // Resolve machine/user_agent: body field > header > undefined
  const headerMachine = c.req.header("X-Machine-Name") ?? undefined;
  const headerUserAgent = c.req.header("User-Agent") ?? undefined;
  const now = new Date().toISOString();

  // Per-item validation
  const validationErrors: (string | null)[] = inputs.map((input) => validateHeartbeatInput(input));
  const ids = inputs.map(() => crypto.randomUUID());
  const validCount = validationErrors.filter((e) => e === null).length;

  // Resolve every distinct User-Agent value once before the heartbeat batch,
  // so a 25-item bulk POST issues at most a handful of upserts instead of one
  // per heartbeat (Issue #99).
  const userAgentCache = new Map<string, string>();
  const userAgentIds: (string | null)[] = new Array(inputs.length).fill(null);
  for (let i = 0; i < inputs.length; i++) {
    if (validationErrors[i]) continue;
    const ua = inputs[i].user_agent ?? headerUserAgent;
    userAgentIds[i] = await resolveUserAgentId(c.env.DB, userId, ua ?? null, userAgentCache);
  }

  // Build insert statements only for valid heartbeats
  const stmts: D1PreparedStatement[] = [];
  const projectTimes = new Map<string, { min: number; max: number }>();

  for (let i = 0; i < inputs.length; i++) {
    if (validationErrors[i]) continue; // skip invalid
    const input = inputs[i];
    const machine = input.machine ?? headerMachine;
    stmts.push(
      bindHeartbeatParams(c.env.DB.prepare(INSERT_HEARTBEAT_SQL), ids[i], userId, input, machine, userAgentIds[i], now)
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
  }
  for (const [project, times] of projectTimes) {
    stmts.push(c.env.DB.prepare(UPSERT_PROJECT_SQL).bind(userId, project, times.min, times.max));
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

  // Map batch results back to per-input indices (valid items only)
  let batchIdx = 0;
  const responses: [HeartbeatBulkItem, number][] = inputs.map((_, i) => {
    if (validationErrors[i]) {
      return [{ data: null, error: validationErrors[i] }, 400];
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
  if (!VALID_TYPES.has(input.type)) return `type must be one of: ${[...VALID_TYPES].join(", ")}`;
  if (typeof input.time !== "number" || !Number.isFinite(input.time)) return "time must be a valid number";
  if (input.category !== undefined && !VALID_CATEGORIES.has(input.category)) {
    return `category must be one of: ${[...VALID_CATEGORIES].join(", ")}`;
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

  if (input.dependencies !== undefined
      && typeof input.dependencies !== "string"
      && !Array.isArray(input.dependencies)) {
    return "dependencies must be a string or array of strings";
  }

  return null;
}

async function insertHeartbeat(
  db: D1Database,
  userId: string,
  input: HeartbeatInput,
  machine: string | undefined,
  userAgent: string | undefined,
): Promise<Heartbeat> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Resolve User-Agent string to a user_agents.id (Issue #99).
  // The upsert runs as a standalone statement (not inside the batch) because
  // D1.batch() does not propagate RETURNING values across statements; we need
  // the id before binding the heartbeat insert.
  const userAgentId = await resolveUserAgentId(db, userId, userAgent ?? null);

  const stmts = [bindHeartbeatParams(db.prepare(INSERT_HEARTBEAT_SQL), id, userId, input, machine, userAgentId, now)];
  if (input.project) {
    stmts.push(db.prepare(UPSERT_PROJECT_SQL).bind(userId, input.project, input.time, input.time));
  }
  await db.batch(stmts);

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
