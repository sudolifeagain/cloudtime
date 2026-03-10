/**
 * Session authentication middleware for auth routes.
 */
import { createMiddleware } from "hono/factory";
import type { SessionAuthEnv } from "../../types";
import { sha256Hex } from "../../utils/crypto";
import { getSessionTokenFromCookie, validateSession } from "../../utils/session";
import { securityHeaders } from "./helpers";

export const sessionMw = createMiddleware<SessionAuthEnv>(async (c, next) => {
  try {
    const token = getSessionTokenFromCookie(c, c.env);
    if (!token) return c.json({ error: "Unauthorized" }, 401, securityHeaders());

    const tokenHash = await sha256Hex(token);
    const session = await validateSession(c.env.DB, c.env.KV, tokenHash);
    if (!session) return c.json({ error: "Unauthorized" }, 401, securityHeaders());

    c.set("userId", session.userId);
    c.set("sessionId", session.sessionId);
    c.set("sessionTokenHash", tokenHash);
    await next();
  } catch (err) {
    console.error("Auth error:", err instanceof Error ? err.stack ?? err.message : err);
    return c.json({ error: "Internal server error" }, 500, securityHeaders());
  }
});
