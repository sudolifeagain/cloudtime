import { createMiddleware } from "hono/factory";
import type { AuthEnv } from "../types";
import { getApiKey, getUserId } from "../utils/auth";
import { sha256Hex } from "../utils/crypto";
import { getSessionTokenFromCookie, validateSession } from "../utils/session";

export const authMiddleware = createMiddleware<AuthEnv>(async (c, next) => {
  // 1. Try API key auth
  const apiKey = getApiKey(c.req);
  if (apiKey) {
    const userId = await getUserId(apiKey, c.env);
    if (userId) {
      c.set("userId", userId);
      return next();
    }
  }

  // 2. Fallback to session cookie
  const sessionToken = getSessionTokenFromCookie(c, c.env);
  if (sessionToken) {
    const tokenHash = await sha256Hex(sessionToken);
    const session = await validateSession(c.env.DB, c.env.KV, tokenHash);
    if (session) {
      c.set("userId", session.userId);
      return next();
    }
  }

  return c.json({ error: "Unauthorized" }, 401);
});
