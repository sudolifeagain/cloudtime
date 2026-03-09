import { Hono } from "hono";
import type { Env } from "../types";
import type { components } from "../types/generated";
import { authMiddleware } from "../middleware/auth";

type HeartbeatInput = components["schemas"]["HeartbeatInput"];
type Heartbeat = components["schemas"]["Heartbeat"];

type AuthEnv = {
  Bindings: Env;
  Variables: { userId: string };
};

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

  const userId = c.get("userId");

  // Convert date string to UNIX epoch range for the day
  const dayStart = new Date(`${date}T00:00:00Z`).getTime() / 1000;
  const dayEnd = dayStart + 86400;

  const rows = await c.env.DB.prepare(
    "SELECT * FROM heartbeats WHERE user_id = ? AND time >= ? AND time < ? ORDER BY time ASC"
  )
    .bind(userId, dayStart, dayEnd)
    .all();

  const data: Heartbeat[] = (rows.results ?? []).map(rowToHeartbeat);

  return c.json({ data });
});

// POST /heartbeats (single)
heartbeats.post("/heartbeats", async (c) => {
  const userId = c.get("userId");
  const input = await c.req.json<HeartbeatInput>();
  const machine = c.req.header("X-Machine-Name") ?? undefined;

  const heartbeat = await insertHeartbeat(c.env.DB, userId, input, machine);

  return c.json({ data: heartbeat }, 201);
});

// POST /heartbeats.bulk
heartbeats.post("/heartbeats.bulk", async (c) => {
  const userId = c.get("userId");
  const inputs = await c.req.json<HeartbeatInput[]>();

  if (!Array.isArray(inputs) || inputs.length === 0) {
    return c.json({ error: "Request body must be a non-empty array" }, 400);
  }
  if (inputs.length > 25) {
    return c.json({ error: "Maximum 25 heartbeats per request" }, 400);
  }

  const machine = c.req.header("X-Machine-Name") ?? undefined;
  const now = new Date().toISOString();

  // Pre-generate IDs for all heartbeats
  const ids = inputs.map(() => crypto.randomUUID());

  // Use D1 batch for bulk insert
  const stmts = inputs.map((input, i) =>
    c.env.DB.prepare(
      `INSERT INTO heartbeats (id, user_id, entity, type, time, category, project, project_root_count, branch, language, dependencies, lines, ai_line_changes, human_line_changes, lineno, cursorpos, is_write, editor, operating_system, machine, user_agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      ids[i],
      userId,
      input.entity,
      input.type,
      input.time,
      input.category ?? null,
      input.project ?? null,
      input.project_root_count ?? null,
      input.branch ?? null,
      input.language ?? null,
      input.dependencies ?? null,
      input.lines ?? null,
      input.ai_line_changes ?? null,
      input.human_line_changes ?? null,
      input.lineno ?? null,
      input.cursorpos ?? null,
      input.is_write ? 1 : 0,
      input.editor ?? null,
      input.operating_system ?? null,
      machine ?? null,
      null
    )
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
  const body = await c.req.json<{ date: string; ids: string[] }>();

  if (!body.date || !Array.isArray(body.ids) || body.ids.length === 0) {
    return c.json({ error: "date and ids are required" }, 400);
  }

  // Delete only heartbeats belonging to this user with matching IDs
  const placeholders = body.ids.map(() => "?").join(", ");
  await c.env.DB.prepare(
    `DELETE FROM heartbeats WHERE user_id = ? AND id IN (${placeholders})`
  )
    .bind(userId, ...body.ids)
    .run();

  return c.body(null, 204);
});

// --- Helpers ---

async function insertHeartbeat(
  db: D1Database,
  userId: string,
  input: HeartbeatInput,
  machine?: string
): Promise<Heartbeat> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO heartbeats (id, user_id, entity, type, time, category, project, project_root_count, branch, language, dependencies, lines, ai_line_changes, human_line_changes, lineno, cursorpos, is_write, editor, operating_system, machine, user_agent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      userId,
      input.entity,
      input.type,
      input.time,
      input.category ?? null,
      input.project ?? null,
      input.project_root_count ?? null,
      input.branch ?? null,
      input.language ?? null,
      input.dependencies ?? null,
      input.lines ?? null,
      input.ai_line_changes ?? null,
      input.human_line_changes ?? null,
      input.lineno ?? null,
      input.cursorpos ?? null,
      input.is_write ? 1 : 0,
      input.editor ?? null,
      input.operating_system ?? null,
      machine ?? null,
      null
    )
    .run();

  return {
    id,
    user_id: userId,
    ...input,
    is_write: input.is_write ?? false,
    machine,
    created_at: now,
  };
}

function rowToHeartbeat(row: Record<string, unknown>): Heartbeat {
  return {
    id: row.id as string,
    user_id: row.user_id as string,
    entity: row.entity as string,
    type: row.type as Heartbeat["type"],
    time: row.time as number,
    category: (row.category as Heartbeat["category"]) ?? undefined,
    project: (row.project as string) ?? undefined,
    project_root_count: (row.project_root_count as number) ?? undefined,
    branch: (row.branch as string) ?? undefined,
    language: (row.language as string) ?? undefined,
    dependencies: (row.dependencies as string) ?? undefined,
    lines: (row.lines as number) ?? undefined,
    ai_line_changes: (row.ai_line_changes as number) ?? undefined,
    human_line_changes: (row.human_line_changes as number) ?? undefined,
    lineno: (row.lineno as number) ?? undefined,
    cursorpos: (row.cursorpos as number) ?? undefined,
    is_write: row.is_write === 1,
    editor: (row.editor as string) ?? undefined,
    operating_system: (row.operating_system as string) ?? undefined,
    machine: (row.machine as string) ?? undefined,
    user_agent_id: (row.user_agent_id as string) ?? undefined,
    created_at: row.created_at as string,
  };
}

export default heartbeats;
