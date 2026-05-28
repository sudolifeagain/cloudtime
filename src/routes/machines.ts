/**
 * Read-only endpoint exposing the machine_names registry populated by
 * heartbeat ingestion (Issue #104).
 *
 * Each device a user sends heartbeats from is upserted into `machine_names`
 * (see src/utils/machine.ts). This route surfaces those rows so clients can
 * show a per-device breakdown. Mirrors src/routes/user-agents.ts.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../types";
import type { components } from "../types/generated";
import { authMiddleware } from "../middleware/auth";
import { normalizeDateTime } from "../utils/user";

type Machine = components["schemas"]["Machine"];

interface MachineRow {
  id: string;
  value: string;
  ip: string | null;
  last_seen_at: string;
  created_at: string;
}

function rowToMachine(row: MachineRow): Machine {
  return {
    id: row.id,
    value: row.value,
    ip: row.ip ?? undefined,
    last_seen_at: normalizeDateTime(row.last_seen_at),
    created_at: normalizeDateTime(row.created_at),
  };
}

const machines = new Hono<AuthEnv>();

machines.use("/machine_names", authMiddleware);

machines.get("/machine_names", async (c) => {
  const userId = c.get("userId");
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, value, ip, last_seen_at, created_at
         FROM machine_names
        WHERE user_id = ?
        ORDER BY last_seen_at DESC`,
    )
      .bind(userId)
      .all<MachineRow>();
    return c.json({ data: results.map(rowToMachine) });
  } catch (err) {
    console.error("GET /machine_names error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default machines;
