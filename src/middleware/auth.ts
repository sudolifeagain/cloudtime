import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type { AuthEnv } from "../types";
import { getApiKey, getUserId } from "../utils/auth";
import { sha256Hex } from "../utils/crypto";
import { getSessionTokenFromCookie, validateSession } from "../utils/session";

const DEFAULT_TIMEOUT_MINUTES = 15;

/**
 * Lazily fetch the authenticated user's profile settings (timezone + heartbeat
 * timeout). Caches both on the Hono context so the D1 query runs at most once
 * per request.
 */
async function loadUserSettings(c: Context<AuthEnv>): Promise<void> {
  if (c.get("userTimezone") !== undefined && c.get("userTimeout") !== undefined) {
    return;
  }
  const row = await c.env.DB
    .prepare("SELECT timezone, timeout FROM users WHERE id = ?")
    .bind(c.get("userId"))
    .first<{ timezone: string; timeout: number }>();
  c.set("userTimezone", row?.timezone ?? "UTC");
  c.set("userTimeout", row?.timeout ?? DEFAULT_TIMEOUT_MINUTES);
}

/**
 * Lazily fetch the authenticated user's profile timezone.
 * Caches on the Hono context so the D1 query runs at most once per request.
 */
export async function getUserTimezone(c: Context<AuthEnv>): Promise<string> {
  await loadUserSettings(c);
  return c.get("userTimezone") ?? "UTC";
}

/**
 * Lazily fetch the authenticated user's heartbeat session timeout in MINUTES
 * (matches the DB column). Falls back to 15 if the user row is missing.
 */
export async function getUserTimeout(c: Context<AuthEnv>): Promise<number> {
  await loadUserSettings(c);
  return c.get("userTimeout") ?? DEFAULT_TIMEOUT_MINUTES;
}

export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  try {
    // 1. Try API key auth — if a key is present but invalid, reject immediately
    const apiKey = getApiKey(c.req);
    if (apiKey) {
      const userId = await getUserId(apiKey, c.env);
      if (!userId) return c.json({ error: "Unauthorized" }, 401);
      c.set("userId", userId);
      await next();
      c.header("Cache-Control", "no-store");
      c.header("Pragma", "no-cache");
      return;
    }

    // 2. No API key — try session cookie
    const sessionToken = getSessionTokenFromCookie(c, c.env);
    if (sessionToken) {
      const tokenHash = await sha256Hex(sessionToken);
      const session = await validateSession(c.env.DB, c.env.KV, tokenHash);
      if (session) {
        c.set("userId", session.userId);
        await next();
        c.header("Cache-Control", "no-store");
        c.header("Pragma", "no-cache");
        return;
      }
    }

    return c.json({ error: "Unauthorized" }, 401);
  } catch (err) {
    console.error("Auth error:", err instanceof Error ? err.stack ?? err.message : err);
    return c.json({ error: "Internal server error" }, 500, {
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    });
  }
});
