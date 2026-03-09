import { Hono } from "hono";
import type { AuthEnv } from "../types";
import type { components } from "../types/generated";
import { authMiddleware } from "../middleware/auth";

type User = components["schemas"]["User"];
type Project = components["schemas"]["Project"];

type UserRow = {
  id: string;
  username: string;
  display_name: string | null;
  email: string | null;
  photo: string | null;
  bio: string | null;
  city: string | null;
  timezone: string;
  timeout: number;
  is_hireable: number;
  github_username: string | null;
  twitter_username: string | null;
  website: string | null;
  created_at: string;
  modified_at: string;
};

const USER_COLUMNS = `id, username, display_name, email, photo, bio, city, timezone, timeout, is_hireable, github_username, twitter_username, website, created_at, modified_at`;

const users = new Hono<AuthEnv>();

users.use("*", authMiddleware);

// ─── Helpers ──────────────────────────────────────────────

function normalizeDateTime(dt: string): string {
  return dt.includes("T") ? dt : dt.replace(" ", "T") + "Z";
}

function rowToUser(
  row: UserRow,
  lastHeartbeat?: { project: string | null; time: number } | null,
): User {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name ?? undefined,
    email: row.email ?? undefined,
    photo: row.photo ?? undefined,
    bio: row.bio ?? undefined,
    city: row.city ?? undefined,
    timezone: row.timezone,
    timeout: row.timeout,
    is_hireable: row.is_hireable === 1,
    github_username: row.github_username ?? undefined,
    twitter_username: row.twitter_username ?? undefined,
    website: row.website ?? undefined,
    plan: "free",
    last_heartbeat_at: lastHeartbeat
      ? new Date(lastHeartbeat.time * 1000).toISOString()
      : undefined,
    last_project: lastHeartbeat?.project ?? undefined,
    created_at: normalizeDateTime(row.created_at),
    modified_at: normalizeDateTime(row.modified_at),
  };
}

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

type ProfileInput = {
  username?: string;
  display_name?: string;
  bio?: string;
  city?: string;
  timezone?: string;
  timeout?: number;
  is_hireable?: boolean;
  github_username?: string;
  twitter_username?: string;
  website?: string;
  photo?: string;
};

function validateProfileInput(body: ProfileInput): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "Request body must be a JSON object";
  }
  if (body.username !== undefined) {
    if (typeof body.username !== "string") return "username must be a string";
    const trimmed = body.username.trim();
    if (trimmed.length < 1 || trimmed.length > 64) return "username must be 1-64 characters";
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) return "username must contain only letters, numbers, hyphens, and underscores";
  }
  if (body.display_name !== undefined) {
    if (typeof body.display_name !== "string") return "display_name must be a string";
    if (body.display_name.trim().length > 128) return "display_name must be at most 128 characters";
  }
  if (body.bio !== undefined) {
    if (typeof body.bio !== "string") return "bio must be a string";
    if (body.bio.trim().length > 256) return "bio must be at most 256 characters";
  }
  if (body.city !== undefined) {
    if (typeof body.city !== "string") return "city must be a string";
    if (body.city.trim().length > 128) return "city must be at most 128 characters";
  }
  if (body.timezone !== undefined) {
    if (typeof body.timezone !== "string") return "timezone must be a string";
    try {
      Intl.DateTimeFormat(undefined, { timeZone: body.timezone });
    } catch {
      return "Invalid timezone";
    }
  }
  if (body.timeout !== undefined) {
    if (typeof body.timeout !== "number" || !Number.isInteger(body.timeout)) return "timeout must be an integer";
    if (body.timeout < 1 || body.timeout > 60) return "timeout must be between 1 and 60";
  }
  if (body.is_hireable !== undefined) {
    if (typeof body.is_hireable !== "boolean") return "is_hireable must be a boolean";
  }
  if (body.github_username !== undefined) {
    if (typeof body.github_username !== "string") return "github_username must be a string";
    if (body.github_username.trim().length > 64) return "github_username must be at most 64 characters";
  }
  if (body.twitter_username !== undefined) {
    if (typeof body.twitter_username !== "string") return "twitter_username must be a string";
    if (body.twitter_username.trim().length > 64) return "twitter_username must be at most 64 characters";
  }
  if (body.website !== undefined) {
    if (typeof body.website !== "string") return "website must be a string";
    if (!body.website.startsWith("http://") && !body.website.startsWith("https://")) {
      return "website must start with http:// or https://";
    }
  }
  if (body.photo !== undefined) {
    if (typeof body.photo !== "string") return "photo must be a string";
    if (!body.photo.startsWith("http://") && !body.photo.startsWith("https://")) {
      return "photo must start with http:// or https://";
    }
  }
  return null;
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

  const updates: string[] = [];
  const params: (string | number)[] = [];

  if (body.username !== undefined) {
    updates.push("username = ?");
    params.push(body.username.trim());
  }
  if (body.display_name !== undefined) {
    updates.push("display_name = ?");
    params.push(body.display_name.trim());
  }
  if (body.bio !== undefined) {
    updates.push("bio = ?");
    params.push(body.bio.trim());
  }
  if (body.city !== undefined) {
    updates.push("city = ?");
    params.push(body.city.trim());
  }
  if (body.timezone !== undefined) {
    updates.push("timezone = ?");
    params.push(body.timezone);
  }
  if (body.timeout !== undefined) {
    updates.push("timeout = ?");
    params.push(body.timeout);
  }
  if (body.is_hireable !== undefined) {
    updates.push("is_hireable = ?");
    params.push(body.is_hireable ? 1 : 0);
  }
  if (body.github_username !== undefined) {
    updates.push("github_username = ?");
    params.push(body.github_username.trim());
  }
  if (body.twitter_username !== undefined) {
    updates.push("twitter_username = ?");
    params.push(body.twitter_username.trim());
  }
  if (body.website !== undefined) {
    updates.push("website = ?");
    params.push(body.website);
  }
  if (body.photo !== undefined) {
    updates.push("photo = ?");
    params.push(body.photo);
  }

  if (updates.length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  updates.push("modified_at = datetime('now')");
  params.push(userId);

  try {
    await c.env.DB.prepare(
      `UPDATE users SET ${updates.join(", ")} WHERE id = ?`,
    )
      .bind(...params)
      .run();
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("UNIQUE constraint failed: users.username")) {
      return c.json({ error: "Username already taken" }, 409);
    }
    return c.json({ error: "Internal server error" }, 500);
  }

  // Re-query to return updated user
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

// ─── GET /projects (getProjects) ────────────────────────

users.get("/projects", async (c) => {
  const userId = c.get("userId");
  const q = c.req.query("q");

  let sql = `SELECT project AS name,
       MIN(time) AS first_heartbeat_time,
       MAX(time) AS last_heartbeat_time
    FROM heartbeats
    WHERE user_id = ? AND project IS NOT NULL AND project != ''`;
  const params: (string | number)[] = [userId];

  if (q) {
    sql += ` AND project LIKE ? ESCAPE '\\'`;
    params.push(`%${escapeLike(q)}%`);
  }

  sql += " GROUP BY project ORDER BY last_heartbeat_time DESC";

  try {
    const { results } = await c.env.DB.prepare(sql)
      .bind(...params)
      .all<{
        name: string;
        first_heartbeat_time: number;
        last_heartbeat_time: number;
      }>();

    const data: Project[] = results.map((row) => ({
      id: row.name,
      name: row.name,
      last_heartbeat_at: new Date(row.last_heartbeat_time * 1000).toISOString(),
      first_heartbeat_at: new Date(
        row.first_heartbeat_time * 1000,
      ).toISOString(),
      created_at: new Date(row.first_heartbeat_time * 1000).toISOString(),
      human_readable_last_heartbeat_at: formatTimeAgo(row.last_heartbeat_time),
    }));

    return c.json({ data });
  } catch {
    return c.json({ error: "Internal server error" }, 500);
  }
});

export default users;
