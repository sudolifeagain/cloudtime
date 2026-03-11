/**
 * Session management, provider management, and API key routes.
 * 8 endpoints: GET/DELETE /session, GET/DELETE /sessions, DELETE /sessions/:id,
 * GET /providers, DELETE /providers/:provider, POST /api-key
 */
import { Hono } from "hono";
import type { SessionAuthEnv } from "../../types";
import { generateApiKey } from "../../utils/crypto";
import { isValidProvider, type OAuthProvider } from "../../utils/oauth";
import {
  invalidateSession,
  invalidateOtherSessions,
  clearSessionCookie,
} from "../../utils/session";
import { type UserRow, USER_COLUMNS, rowToUser, normalizeDateTime } from "../../utils/user";
import { sessionMw } from "./middleware";
import { securityHeaders } from "./helpers";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sessions = new Hono<SessionAuthEnv>();

sessions.use("*", sessionMw);

// GET /session
sessions.get("/session", async (c) => {
  try {
    const userId = c.get("userId");
    const [userRow, providers] = await Promise.all([
      c.env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
        .bind(userId)
        .first<UserRow>(),
      c.env.DB.prepare(
        "SELECT provider, provider_user_id, provider_username, provider_email, email_verified, created_at FROM oauth_accounts WHERE user_id = ?",
      )
        .bind(userId)
        .all<{
          provider: string;
          provider_user_id: string;
          provider_username: string | null;
          provider_email: string | null;
          email_verified: number;
          created_at: string;
        }>(),
    ]);

    if (!userRow) return c.json({ error: "Unauthorized" }, 401);

    return c.json(
      {
        data: {
          user: rowToUser(userRow),
          providers: providers.results.map((p) => ({
            provider: p.provider as OAuthProvider,
            provider_user_id: p.provider_user_id,
            provider_username: p.provider_username ?? "",
            provider_email: p.provider_email ?? undefined,
            email_verified: p.email_verified === 1,
            created_at: normalizeDateTime(p.created_at),
          })),
        },
      },
    );
  } catch (err) {
    console.error("Auth error:", err instanceof Error ? err.stack ?? err.message : err);
    return c.json({ error: "Internal server error" }, 500, securityHeaders());
  }
});

// DELETE /session (logout)
sessions.delete("/session", async (c) => {
  try {
    const tokenHash = c.get("sessionTokenHash");
    await invalidateSession(c.env.DB, c.env.KV, tokenHash);
    clearSessionCookie(c, c.env);
    return c.body(null, 204, {
      "Clear-Site-Data": '"cookies", "storage"',
    });
  } catch (err) {
    console.error("Auth error:", err instanceof Error ? err.stack ?? err.message : err);
    return c.json({ error: "Internal server error" }, 500, securityHeaders());
  }
});

// GET /sessions (list all active sessions)
sessions.get("/sessions", async (c) => {
  try {
    const userId = c.get("userId");
    const currentSessionId = c.get("sessionId");

    const { results } = await c.env.DB.prepare(
      `SELECT id, ip, country, city, user_agent, created_at, expires_at, last_active_at
       FROM sessions WHERE user_id = ? AND expires_at > datetime('now')
         AND last_active_at >= datetime('now', '-1 day')
       ORDER BY last_active_at DESC`,
    )
      .bind(userId)
      .all<{
        id: string;
        ip: string | null;
        country: string | null;
        city: string | null;
        user_agent: string | null;
        created_at: string;
        expires_at: string;
        last_active_at: string;
      }>();

    return c.json(
      {
        data: results.map((s) => ({
          id: s.id,
          ip: s.ip ?? undefined,
          country: s.country ?? undefined,
          city: s.city ?? undefined,
          user_agent: s.user_agent ?? undefined,
          created_at: normalizeDateTime(s.created_at),
          last_active_at: normalizeDateTime(s.last_active_at),
          expires_at: normalizeDateTime(s.expires_at),
          is_current: s.id === currentSessionId,
        })),
      },
    );
  } catch (err) {
    console.error("Auth error:", err instanceof Error ? err.stack ?? err.message : err);
    return c.json({ error: "Internal server error" }, 500, securityHeaders());
  }
});

// DELETE /sessions (revoke all other sessions)
sessions.delete("/sessions", async (c) => {
  try {
    const userId = c.get("userId");
    const currentTokenHash = c.get("sessionTokenHash");
    await invalidateOtherSessions(c.env.DB, c.env.KV, userId, currentTokenHash);
    return c.body(null, 204);
  } catch (err) {
    console.error("Auth error:", err instanceof Error ? err.stack ?? err.message : err);
    return c.json({ error: "Internal server error" }, 500, securityHeaders());
  }
});

// DELETE /sessions/:session_id
sessions.delete("/sessions/:session_id", async (c) => {
  try {
    const userId = c.get("userId");
    const targetSessionId = c.req.param("session_id");
    if (!UUID_RE.test(targetSessionId)) {
      return c.json({ error: "Invalid session ID" }, 400);
    }
    const currentSessionId = c.get("sessionId");

    const target = await c.env.DB.prepare(
      "SELECT token_hash FROM sessions WHERE id = ? AND user_id = ?",
    )
      .bind(targetSessionId, userId)
      .first<{ token_hash: string }>();

    if (!target) return c.json({ error: "Not found" }, 404);

    await invalidateSession(c.env.DB, c.env.KV, target.token_hash);

    if (targetSessionId === currentSessionId) {
      clearSessionCookie(c, c.env);
    }

    return c.body(null, 204);
  } catch (err) {
    console.error("Auth error:", err instanceof Error ? err.stack ?? err.message : err);
    return c.json({ error: "Internal server error" }, 500, securityHeaders());
  }
});

// GET /providers (list linked providers)
sessions.get("/providers", async (c) => {
  try {
    const userId = c.get("userId");

    const { results } = await c.env.DB.prepare(
      "SELECT provider, provider_user_id, provider_username, provider_email, email_verified, created_at FROM oauth_accounts WHERE user_id = ?",
    )
      .bind(userId)
      .all<{
        provider: string;
        provider_user_id: string;
        provider_username: string | null;
        provider_email: string | null;
        email_verified: number;
        created_at: string;
      }>();

    return c.json({
      data: results.map((p) => ({
        provider: p.provider as OAuthProvider,
        provider_user_id: p.provider_user_id,
        provider_username: p.provider_username ?? "",
        provider_email: p.provider_email ?? undefined,
        email_verified: p.email_verified === 1,
        created_at: normalizeDateTime(p.created_at),
      })),
    });
  } catch (err) {
    console.error("Auth error:", err instanceof Error ? err.stack ?? err.message : err);
    return c.json({ error: "Internal server error" }, 500, securityHeaders());
  }
});

// DELETE /providers/:provider (unlink)
sessions.delete("/providers/:provider", async (c) => {
  try {
    const userId = c.get("userId");
    const provider = c.req.param("provider");

    if (!isValidProvider(provider)) {
      return c.json({ error: "Invalid provider" }, 400);
    }

    const [{ results: linked }, userRow] = await Promise.all([
      c.env.DB.prepare("SELECT provider FROM oauth_accounts WHERE user_id = ?")
        .bind(userId)
        .all<{ provider: string }>(),
      c.env.DB.prepare("SELECT api_key_hash FROM users WHERE id = ?")
        .bind(userId)
        .first<{ api_key_hash: string }>(),
    ]);

    // api_key_hash is NOT NULL, so hasApiKey is always true — guard is defensive
    const hasApiKey = !!userRow?.api_key_hash;
    const otherProviders = linked.filter((p) => p.provider !== provider).length;
    if (otherProviders === 0 && !hasApiKey) {
      return c.json({ error: "Cannot unlink the only authentication method" }, 400);
    }

    await c.env.DB.prepare("DELETE FROM oauth_accounts WHERE user_id = ? AND provider = ?")
      .bind(userId, provider)
      .run();

    return c.body(null, 204);
  } catch (err) {
    console.error("Auth error:", err instanceof Error ? err.stack ?? err.message : err);
    return c.json({ error: "Internal server error" }, 500, securityHeaders());
  }
});

// POST /api-key (regenerate)
sessions.post("/api-key", async (c) => {
  try {
    const userId = c.get("userId");
    const currentTokenHash = c.get("sessionTokenHash");

    const user = await c.env.DB.prepare("SELECT api_key_hash FROM users WHERE id = ?")
      .bind(userId)
      .first<{ api_key_hash: string }>();

    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const { plaintext, hash } = await generateApiKey();

    // Delete old API key from KV cache before updating DB to prevent stale cache hits.
    // If the DB update fails after this, the old key is still valid in D1 and will
    // be re-cached on next use.
    await c.env.KV.delete(`apikey:${user.api_key_hash}`);

    await c.env.DB.prepare("UPDATE users SET api_key_hash = ?, modified_at = datetime('now') WHERE id = ?")
      .bind(hash, userId)
      .run();

    await invalidateOtherSessions(c.env.DB, c.env.KV, userId, currentTokenHash);

    return c.json({ data: { api_key: plaintext } });
  } catch (err) {
    console.error("Auth error:", err instanceof Error ? err.stack ?? err.message : err);
    return c.json({ error: "Internal server error" }, 500, securityHeaders());
  }
});

export default sessions;
