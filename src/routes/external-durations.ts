/**
 * External durations — calendar / non-coding time (specs/106-external-durations/).
 *
 * A parallel, non-coding time series: create/bulk-create upsert on
 * (user_id, external_id) so syncs are idempotent; list is day-scoped by
 * start_time; bulk delete removes by id within a day. NOT aggregated into
 * summaries — the cron aggregator is untouched.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../types";
import type { components } from "../types/generated";
import { authMiddleware, getUserTimezone } from "../middleware/auth";
import { getEpochBoundsForDate, isValidTimezone } from "../utils/time-format";
import { normalizeDateTime } from "../utils/user";
import {
  validateExternalDuration,
  type ValidatedExternalDuration,
} from "../utils/external-duration-input";

type ExternalDuration = components["schemas"]["ExternalDuration"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BULK = 100;

interface ExternalDurationRow {
  id: string;
  user_id: string;
  external_id: string;
  entity: string;
  type: string;
  category: string | null;
  start_time: number;
  end_time: number;
  project: string | null;
  branch: string | null;
  language: string | null;
  meta: string | null;
  created_at: string;
}

const RETURNING_COLUMNS =
  "id, user_id, external_id, entity, type, category, start_time, end_time, project, branch, language, meta, created_at";

const UPSERT_SQL = `INSERT INTO external_durations
  (id, user_id, external_id, entity, type, category, start_time, end_time, project, branch, language, meta)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (user_id, external_id) DO UPDATE SET
  entity = excluded.entity,
  type = excluded.type,
  category = excluded.category,
  start_time = excluded.start_time,
  end_time = excluded.end_time,
  project = excluded.project,
  branch = excluded.branch,
  language = excluded.language,
  meta = excluded.meta
RETURNING ${RETURNING_COLUMNS}`;

function parseDateString(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const [y, m, d] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  return (
    utc.getUTCFullYear() === y &&
    utc.getUTCMonth() === m - 1 &&
    utc.getUTCDate() === d
  );
}

function upsertStmt(
  db: D1Database,
  userId: string,
  v: ValidatedExternalDuration,
): D1PreparedStatement {
  return db.prepare(UPSERT_SQL).bind(
    crypto.randomUUID(),
    userId,
    v.external_id,
    v.entity,
    v.type,
    v.category,
    v.start_time,
    v.end_time,
    v.project,
    v.branch,
    v.language,
    v.meta,
  );
}

function rowToExternalDuration(row: ExternalDurationRow): ExternalDuration {
  return {
    id: row.id,
    user_id: row.user_id,
    external_id: row.external_id,
    entity: row.entity,
    type: row.type as ExternalDuration["type"],
    category: (row.category ?? undefined) as ExternalDuration["category"],
    start_time: row.start_time,
    end_time: row.end_time,
    project: row.project ?? undefined,
    branch: row.branch ?? undefined,
    language: row.language ?? undefined,
    meta: row.meta ?? undefined,
    created_at: normalizeDateTime(row.created_at),
  };
}

const externalDurations = new Hono<AuthEnv>();

externalDurations.use("/external_durations", authMiddleware);
externalDurations.use("/external_durations.bulk", authMiddleware);

externalDurations.get("/external_durations", async (c) => {
  const userId = c.get("userId");

  const date = c.req.query("date");
  if (!date || !parseDateString(date)) {
    return c.json({ error: "date query parameter is required (YYYY-MM-DD)" }, 400);
  }
  const tzParam = c.req.query("timezone");
  if (tzParam !== undefined && !isValidTimezone(tzParam)) {
    return c.json({ error: "Invalid timezone" }, 400);
  }
  const tz = tzParam ?? (await getUserTimezone(c));
  const { start, end } = getEpochBoundsForDate(date, tz);

  const conditions = ["user_id = ?", "start_time >= ?", "start_time < ?"];
  const binds: (string | number)[] = [userId, start, end];

  const project = c.req.query("project");
  if (project !== undefined) {
    conditions.push("project = ?");
    binds.push(project);
  }
  const branches = c.req.query("branches");
  if (branches !== undefined) {
    const list = branches.split(",").map((b) => b.trim()).filter((b) => b.length > 0);
    if (list.length > 0) {
      conditions.push(`branch IN (${list.map(() => "?").join(", ")})`);
      binds.push(...list);
    }
  }

  try {
    const { results } = await c.env.DB.prepare(
      `SELECT ${RETURNING_COLUMNS} FROM external_durations
        WHERE ${conditions.join(" AND ")}
        ORDER BY start_time ASC`,
    )
      .bind(...binds)
      .all<ExternalDurationRow>();
    return c.json({ data: results.map(rowToExternalDuration) });
  } catch (err) {
    console.error("GET /external_durations error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

externalDurations.post("/external_durations", async (c) => {
  const userId = c.get("userId");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  const parsed = validateExternalDuration(body);
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, 400);
  }

  try {
    const row = await upsertStmt(c.env.DB, userId, parsed.value).first<ExternalDurationRow>();
    if (!row) {
      console.error("POST /external_durations error: upsert returned no row");
      return c.json({ error: "Internal server error" }, 500);
    }
    return c.json({ data: rowToExternalDuration(row) }, 201);
  } catch (err) {
    console.error("POST /external_durations error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

externalDurations.post("/external_durations.bulk", async (c) => {
  const userId = c.get("userId");

  let inputs: unknown;
  try {
    inputs = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  if (!Array.isArray(inputs)) {
    return c.json({ error: "Request body must be an array" }, 400);
  }
  if (inputs.length > MAX_BULK) {
    return c.json({ error: `Maximum ${MAX_BULK} external durations per request` }, 400);
  }

  // All-or-nothing: validate every element before writing anything.
  const validated: ValidatedExternalDuration[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const parsed = validateExternalDuration(inputs[i]);
    if (!parsed.ok) {
      return c.json({ error: `item ${i}: ${parsed.error}` }, 400);
    }
    validated.push(parsed.value);
  }

  if (validated.length === 0) {
    return c.json({ data: [] }, 201);
  }

  try {
    const batchResults = await c.env.DB.batch<ExternalDurationRow>(
      validated.map((v) => upsertStmt(c.env.DB, userId, v)),
    );
    const data = batchResults
      .map((res) => res.results?.[0])
      .filter((row): row is ExternalDurationRow => row !== undefined)
      .map(rowToExternalDuration);
    return c.json({ data }, 201);
  } catch (err) {
    console.error("POST /external_durations.bulk error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

externalDurations.delete("/external_durations.bulk", async (c) => {
  const userId = c.get("userId");

  let body: { date?: unknown; ids?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  const date = body.date;
  const ids = body.ids;
  if (typeof date !== "string" || !parseDateString(date)) {
    return c.json({ error: "date is required (YYYY-MM-DD)" }, 400);
  }
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string" && id.length > 0)) {
    return c.json({ error: "ids must be a non-empty array of strings" }, 400);
  }

  const tz = await getUserTimezone(c);
  const { start, end } = getEpochBoundsForDate(date, tz);

  try {
    const placeholders = ids.map(() => "?").join(", ");
    await c.env.DB.prepare(
      `DELETE FROM external_durations
        WHERE user_id = ? AND start_time >= ? AND start_time < ? AND id IN (${placeholders})`,
    )
      .bind(userId, start, end, ...ids)
      .run();
    return c.body(null, 204);
  } catch (err) {
    console.error("DELETE /external_durations.bulk error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default externalDurations;
