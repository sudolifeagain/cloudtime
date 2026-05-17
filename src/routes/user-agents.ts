/**
 * Read-only endpoint exposing the user_agents resolved by heartbeat
 * ingestion (Issue #105).
 *
 * The `user_agents` table is populated server-side as each heartbeat is
 * received (see src/utils/user-agent.ts). This route surfaces those rows so
 * that clients / dashboards can show a per-plugin breakdown of activity.
 */
import { Hono } from "hono";
import type { AuthEnv } from "../types";
import type { components } from "../types/generated";
import { authMiddleware } from "../middleware/auth";
import { normalizeDateTime } from "../utils/user";

type UserAgent = components["schemas"]["UserAgent"];

interface UserAgentRow {
  id: string;
  value: string;
  editor: string | null;
  version: string | null;
  os: string | null;
  is_browser_extension: number;
  is_desktop_app: number;
  last_seen_at: string;
  created_at: string;
}

function rowToUserAgent(row: UserAgentRow): UserAgent {
  return {
    id: row.id,
    value: row.value,
    editor: row.editor ?? undefined,
    version: row.version ?? undefined,
    os: row.os ?? undefined,
    is_browser_extension: row.is_browser_extension === 1,
    is_desktop_app: row.is_desktop_app === 1,
    last_seen_at: normalizeDateTime(row.last_seen_at),
    created_at: normalizeDateTime(row.created_at),
  };
}

const userAgents = new Hono<AuthEnv>();

userAgents.use("/user_agents", authMiddleware);

userAgents.get("/user_agents", async (c) => {
  const userId = c.get("userId");
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, value, editor, version, os, is_browser_extension,
              is_desktop_app, last_seen_at, created_at
         FROM user_agents
        WHERE user_id = ?
        ORDER BY last_seen_at DESC`,
    )
      .bind(userId)
      .all<UserAgentRow>();
    return c.json({ data: results.map(rowToUserAgent) });
  } catch (err) {
    console.error("GET /user_agents error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default userAgents;
