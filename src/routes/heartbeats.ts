import { Hono } from "hono";
import type { AuthEnv } from "../types";
import type { components } from "../types/generated";
import { authMiddleware } from "../middleware/auth";

type HeartbeatInput = components["schemas"]["HeartbeatInput"];
type Heartbeat = components["schemas"]["Heartbeat"];

// D1 row representation (is_write is integer, created_at may be non-ISO)
type HeartbeatRow = Omit<Heartbeat, "is_write" | "created_at"> & {
  is_write: number;
  created_at: string;
};

const VALID_TYPES = new Set(["file", "app", "domain"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const INSERT_HEARTBEAT_SQL = `INSERT INTO heartbeats (id, user_id, entity, type, time, category, project, project_root_count, branch, language, dependencies, lines, ai_line_changes, human_line_changes, lineno, cursorpos, is_write, editor, operating_system, machine, user_agent_id, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function bindHeartbeatParams(
  stmt: D1PreparedStatement,
  id: string,
  userId: string,
  input: HeartbeatInput,
  machine: string | undefined,
  now: string
): D1PreparedStatement {
  return stmt.bind(
    id, userId, input.entity, input.type, input.time,
    input.category ?? null, input.project ?? null, input.project_root_count ?? null,
    input.branch ?? null, input.language ?? null, input.dependencies ?? null,
    input.lines ?? null, input.ai_line_changes ?? null, input.human_line_changes ?? null,
    input.lineno ?? null, input.cursorpos ?? null, input.is_write ? 1 : 0,
    input.editor ?? null, input.operating_system ?? null,
    machine ?? null,
    null, // TODO: user_agent_id — resolve from User-Agent header to user_agents table
    now
  );
}

const heartbeats = new Hono<AuthEnv>();

heartbeats.use("/heartbeats", authMiddleware);
heartbeats.use("/heartbeats/*", authMiddleware);
heartbeats.use("/heartbeats.bulk", authMiddleware);

// GET /heartbeats?date=YYYY-MM-DD
heartbeats.get("/heartbeats", async (c) => {
  const date = c.req.query("date");
  if (!date) {
    return c.json({ error: "date query parameter is required" }, 400);
  }
  if (!DATE_RE.test(date)) {
    return c.json({ error: "date must be in YYYY-MM-DD format" }, 400);
  }

  // TODO: Apply user's timezone setting (users.timezone) instead of UTC
  const dayStart = new Date(`${date}T00:00:00Z`).getTime() / 1000;
  if (!Number.isFinite(dayStart)) {
    return c.json({ error: "Invalid date" }, 400);
  }
  const dayEnd = dayStart + 86400;

  const userId = c.get("userId");

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM heartbeats WHERE user_id = ? AND time >= ? AND time < ? ORDER BY time ASC"
  )
    .bind(userId, dayStart, dayEnd)
    .all<HeartbeatRow>();

  const data: Heartbeat[] = results.map(rowToHeartbeat);

  return c.json({ data });
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

  const machine = c.req.header("X-Machine-Name") ?? undefined;
  const heartbeat = await insertHeartbeat(c.env.DB, userId, input, machine);

  return c.json({ data: heartbeat }, 201);
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

  for (let i = 0; i < inputs.length; i++) {
    const err = validateHeartbeatInput(inputs[i]);
    if (err) {
      return c.json({ error: `heartbeats[${i}]: ${err}` }, 400);
    }
  }

  const machine = c.req.header("X-Machine-Name") ?? undefined;
  const now = new Date().toISOString();

  // Pre-generate IDs for all heartbeats
  const ids = inputs.map(() => crypto.randomUUID());

  // Use D1 batch for bulk insert
  const stmts = inputs.map((input, i) =>
    bindHeartbeatParams(c.env.DB.prepare(INSERT_HEARTBEAT_SQL), ids[i], userId, input, machine, now)
  );

  const results = await c.env.DB.batch(stmts);

  const responses: [Heartbeat, number][] = inputs.map((input, i) => {
    const heartbeat: Heartbeat = {
      id: ids[i],
      user_id: userId,
      ...input,
      is_write: input.is_write ?? false,
      machine,
      created_at: now,
    };
    const success = results[i]?.success ?? false;
    return [heartbeat, success ? 201 : 500];
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
  if (!DATE_RE.test(body.date)) {
    return c.json({ error: "date must be in YYYY-MM-DD format" }, 400);
  }

  const dayStart = new Date(`${body.date}T00:00:00Z`).getTime() / 1000;
  if (!Number.isFinite(dayStart)) {
    return c.json({ error: "Invalid date" }, 400);
  }
  const dayEnd = dayStart + 86400;

  // Scope deletion by user, IDs, and date range
  const placeholders = body.ids.map(() => "?").join(", ");
  await c.env.DB.prepare(
    `DELETE FROM heartbeats WHERE user_id = ? AND time >= ? AND time < ? AND id IN (${placeholders})`
  )
    .bind(userId, dayStart, dayEnd, ...body.ids)
    .run();

  return c.body(null, 204);
});

// --- Helpers ---

function validateHeartbeatInput(input: HeartbeatInput): string | null {
  if (!input || typeof input !== "object") return "must be an object";
  if (typeof input.entity !== "string" || input.entity.length === 0) return "entity is required";
  if (!VALID_TYPES.has(input.type)) return "type must be one of: file, app, domain";
  if (typeof input.time !== "number" || !Number.isFinite(input.time)) return "time must be a valid number";
  return null;
}

async function insertHeartbeat(
  db: D1Database,
  userId: string,
  input: HeartbeatInput,
  machine?: string
): Promise<Heartbeat> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await bindHeartbeatParams(db.prepare(INSERT_HEARTBEAT_SQL), id, userId, input, machine, now).run();

  return {
    id,
    user_id: userId,
    ...input,
    is_write: input.is_write ?? false,
    machine,
    created_at: now,
  };
}

function rowToHeartbeat(row: HeartbeatRow): Heartbeat {
  // Normalize created_at to ISO 8601 (handle legacy D1 datetime('now') format)
  const createdAt = row.created_at.includes("T")
    ? row.created_at
    : row.created_at.replace(" ", "T") + "Z";

  return {
    ...row,
    is_write: row.is_write === 1,
    created_at: createdAt,
  };
}

export default heartbeats;
