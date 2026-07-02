import { Hono } from "hono";
import type { AuthEnv } from "../types";
import type { components } from "../types/generated";
import { authMiddleware } from "../middleware/auth";
import { type UserRow, USER_COLUMNS, rowToUser } from "../utils/user";
import { NoProfileFieldsError, type ProfileInput, updateUserProfile, validateProfileInput } from "../utils/profile";

type Project = components["schemas"]["Project"];

const users = new Hono<AuthEnv>();

users.use("*", authMiddleware);

// ─── Helpers ──────────────────────────────────────────────

function formatTimeAgo(epoch: number): string {
  const seconds = Math.floor(Date.now() / 1000 - epoch);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min${minutes !== 1 ? "s" : ""} ago`;
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  if (hours < 24) {
    if (remainingMins === 0) return `${hours} hr${hours !== 1 ? "s" : ""} ago`;
    return `${hours} hr${hours !== 1 ? "s" : ""} ${remainingMins} min${remainingMins !== 1 ? "s" : ""} ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days} day${days !== 1 ? "s" : ""} ago`;
}

function escapeLike(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// ─── GET / (getCurrentUser) ──────────────────────────────

users.get("/", async (c) => {
  const userId = c.get("userId");

  try {
    const [userRow, lastHB] = await Promise.all([
      c.env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
        .bind(userId)
        .first<UserRow>(),
      c.env.DB.prepare(
        "SELECT project, time FROM heartbeats WHERE user_id = ? ORDER BY time DESC LIMIT 1",
      )
        .bind(userId)
        .first<{ project: string | null; time: number }>(),
    ]);

    if (!userRow) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    return c.json({ data: rowToUser(userRow, lastHB) });
  } catch {
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── PATCH /profile (updateProfile) ─────────────────────

users.patch("/profile", async (c) => {
  const userId = c.get("userId");

  let body: ProfileInput;
  try {
    body = await c.req.json<ProfileInput>();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const err = validateProfileInput(body);
  if (err) {
    return c.json({ error: err }, 400);
  }

  try {
    const [userRow, lastHB] = await Promise.all([
      updateUserProfile(c.env.DB, userId, body),
      c.env.DB.prepare(
        "SELECT project, time FROM heartbeats WHERE user_id = ? ORDER BY time DESC LIMIT 1",
      )
        .bind(userId)
        .first<{ project: string | null; time: number }>(),
    ]);

    if (!userRow) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    return c.json({ data: rowToUser(userRow, lastHB) });
  } catch (e: unknown) {
    if (e instanceof NoProfileFieldsError) {
      return c.json({ error: "No fields to update" }, 400);
    }
    if (e instanceof Error && e.message.includes("UNIQUE constraint failed: users.username")) {
      return c.json({ error: "Username already taken" }, 409);
    }
    return c.json({ error: "Internal server error" }, 500);
  }
});

// ─── GET /projects (getProjects) ────────────────────────

users.get("/projects", async (c) => {
  const userId = c.get("userId");
  const q = c.req.query("q");

  let sql = `SELECT project, first_heartbeat_at, last_heartbeat_at
    FROM user_projects WHERE user_id = ?`;
  const params: (string | number)[] = [userId];

  if (q) {
    sql += ` AND project LIKE ? ESCAPE '\\'`;
    params.push(`%${escapeLike(q)}%`);
  }

  sql += " ORDER BY last_heartbeat_at DESC";

  try {
    const { results } = await c.env.DB.prepare(sql)
      .bind(...params)
      .all<{
        project: string;
        first_heartbeat_at: number;
        last_heartbeat_at: number;
      }>();

    const data: Project[] = results.map((row) => ({
      id: row.project,
      name: row.project,
      urlencoded_name: encodeURIComponent(row.project),
      last_heartbeat_at: new Date(row.last_heartbeat_at * 1000).toISOString(),
      human_readable_last_heartbeat_at: formatTimeAgo(row.last_heartbeat_at),
      first_heartbeat_at: new Date(row.first_heartbeat_at * 1000).toISOString(),
      human_readable_first_heartbeat_at: formatTimeAgo(row.first_heartbeat_at),
      created_at: new Date(row.first_heartbeat_at * 1000).toISOString(),
    }));

    return c.json({ data });
  } catch {
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default users;
