import { type UserRow, USER_COLUMNS } from "./user";

export type ProfileInput = {
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

export class NoProfileFieldsError extends Error {
  constructor() {
    super("No fields to update");
  }
}

export function validateProfileInput(body: ProfileInput): string | null {
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
    if (body.website !== "" && !body.website.startsWith("http://") && !body.website.startsWith("https://")) {
      return "website must start with http:// or https://";
    }
  }
  if (body.photo !== undefined) {
    if (typeof body.photo !== "string") return "photo must be a string";
    if (body.photo !== "" && !body.photo.startsWith("http://") && !body.photo.startsWith("https://")) {
      return "photo must start with http:// or https://";
    }
  }
  return null;
}

export async function updateUserProfile(
  db: D1Database,
  userId: string,
  body: ProfileInput,
): Promise<UserRow | null> {
  const updates: string[] = [];
  const params: (string | number | null)[] = [];

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
    params.push(body.website || null);
  }
  if (body.photo !== undefined) {
    updates.push("photo = ?");
    params.push(body.photo || null);
  }

  if (updates.length === 0) {
    throw new NoProfileFieldsError();
  }

  updates.push("modified_at = datetime('now')");
  params.push(userId);

  return db.prepare(
    `UPDATE users SET ${updates.join(", ")} WHERE id = ? RETURNING ${USER_COLUMNS}`,
  )
    .bind(...params)
    .first<UserRow>();
}

