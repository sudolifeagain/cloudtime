/**
 * User-facing data export endpoints (Issue #102).
 *
 * Gated on a bound `R2_BUCKET` — fail closed with 503 when unbound (the same
 * pattern as email delivery). `POST` records a pending dump (deduping
 * in-flight requests); the hourly cron builds it into R2 and a worker-mediated
 * download route streams it back to the owner while it is unexpired.
 */
import { Hono } from "hono";
import type { AuthEnv, Env } from "../types";
import type { components } from "../types/generated";
import { authMiddleware } from "../middleware/auth";
import { normalizeDateTime } from "../utils/user";
import { dumpObjectKey } from "../utils/export-bundle";

type DataDump = components["schemas"]["DataDump"];

const VALID_TYPES = new Set<string>(["daily", "full"]);

interface DataDumpRow {
  id: string;
  type: string;
  status: string;
  download_url: string | null;
  created_at: string;
  expires_at: string | null;
}

const SELECT_COLUMNS = "id, type, status, download_url, created_at, expires_at";

function exportEnabled(env: Env): boolean {
  return !!env.R2_BUCKET;
}

function rowToDump(row: DataDumpRow): DataDump {
  return {
    id: row.id,
    type: row.type as DataDump["type"],
    status: row.status as DataDump["status"],
    download_url: row.download_url ?? undefined,
    created_at: normalizeDateTime(row.created_at),
    expires_at: row.expires_at ? normalizeDateTime(row.expires_at) : undefined,
  };
}

const dataDumps = new Hono<AuthEnv>();

dataDumps.use("/data_dumps", authMiddleware);
dataDumps.use("/data_dumps/*", authMiddleware);

dataDumps.get("/data_dumps", async (c) => {
  if (!exportEnabled(c.env)) {
    return c.json({ error: "Data export not configured" }, 503);
  }
  const userId = c.get("userId");
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT ${SELECT_COLUMNS} FROM data_dumps WHERE user_id = ? ORDER BY created_at DESC`,
    )
      .bind(userId)
      .all<DataDumpRow>();
    return c.json({ data: results.map(rowToDump) });
  } catch (err) {
    console.error("GET /data_dumps error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

dataDumps.post("/data_dumps", async (c) => {
  if (!exportEnabled(c.env)) {
    return c.json({ error: "Data export not configured" }, 503);
  }
  const userId = c.get("userId");

  let body: { type?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  if (!VALID_TYPES.has(body.type as string)) {
    return c.json({ error: "type must be one of daily, full" }, 400);
  }
  const type = body.type as string;

  try {
    // Dedupe: reuse an in-flight dump of the same type rather than queuing another.
    const existing = await c.env.DB.prepare(
      `SELECT ${SELECT_COLUMNS} FROM data_dumps
        WHERE user_id = ? AND type = ? AND status IN ('pending', 'processing')
        ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(userId, type)
      .first<DataDumpRow>();
    if (existing) {
      return c.json({ data: rowToDump(existing) }, 201);
    }

    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      "INSERT INTO data_dumps (id, user_id, type, status) VALUES (?, ?, ?, 'pending')",
    )
      .bind(id, userId, type)
      .run();

    const row = await c.env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM data_dumps WHERE id = ? AND user_id = ?`)
      .bind(id, userId)
      .first<DataDumpRow>();
    if (!row) {
      console.error("POST /data_dumps error: inserted dump not found on re-read", id);
      return c.json({ error: "Internal server error" }, 500);
    }
    return c.json({ data: rowToDump(row) }, 201);
  } catch (err) {
    console.error("POST /data_dumps error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// Worker-mediated download: owner-scoped + status/expiry checked, streamed from
// R2. Referenced by the opaque `download_url`; not a documented API operation.
dataDumps.get("/data_dumps/:id/download", async (c) => {
  if (!exportEnabled(c.env) || !c.env.R2_BUCKET) {
    return c.json({ error: "Data export not configured" }, 503);
  }
  const userId = c.get("userId");
  const id = c.req.param("id");

  try {
    const row = await c.env.DB.prepare(
      `SELECT ${SELECT_COLUMNS} FROM data_dumps WHERE id = ? AND user_id = ?`,
    )
      .bind(id, userId)
      .first<DataDumpRow>();

    if (!row || row.status !== "completed") {
      return c.json({ error: "Not found" }, 404);
    }
    if (row.expires_at && new Date(normalizeDateTime(row.expires_at)).getTime() < Date.now()) {
      return c.json({ error: "Not found" }, 404);
    }

    const object = await c.env.R2_BUCKET.get(dumpObjectKey(userId, id));
    if (!object) {
      return c.json({ error: "Not found" }, 404);
    }
    return new Response(object.body, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="cloudtime-export-${id}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("GET /data_dumps/:id/download error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default dataDumps;
