import { createMiddleware } from "hono/factory";
import type { AuthEnv } from "../types";
import { getApiKey, getUserId } from "../utils/auth";
import { sha256Hex } from "../utils/crypto";
import { getSessionTokenFromCookie, validateSession } from "../utils/session";

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
