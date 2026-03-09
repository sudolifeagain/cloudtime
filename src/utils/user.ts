/**
 * Shared user row mapping utilities.
 * Extracted from routes/users.ts for reuse in auth routes.
 */
import type { components } from "../types/generated";

type User = components["schemas"]["User"];

export type UserRow = {
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

export const USER_COLUMNS = `id, username, display_name, email, photo, bio, city, timezone, timeout, is_hireable, github_username, twitter_username, website, created_at, modified_at`;

export function normalizeDateTime(dt: string): string {
  return dt.includes("T") ? dt : dt.replace(" ", "T") + "Z";
}

export function rowToUser(
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
