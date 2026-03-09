/**
 * OAuth authentication routes — 13 endpoints across 4 flows.
 */
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { csrf } from "hono/csrf";
import type { Env, SessionAuthEnv } from "../types";
import {
  sha256Hex,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  generateNonce,
  generateSessionToken,
  generateApiKey,
  encryptToken,
  timingSafeEqual,
} from "../utils/crypto";
import {
  isValidProvider,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserInfo,
  type OAuthProvider,
} from "../utils/oauth";
import {
  createSession,
  validateSession,
  invalidateSession,
  invalidateOtherSessions,
  setSessionCookie,
  clearSessionCookie,
  getSessionTokenFromCookie,
  storeOAuthState,
  consumeOAuthState,
  setStateCookie,
  getStateCookie,
  clearStateCookie,
} from "../utils/session";
import { type UserRow, USER_COLUMNS, rowToUser, normalizeDateTime } from "../utils/user";

const auth = new Hono<{ Bindings: Env }>();

// CSRF protection — validates Origin header for non-safe methods (POST, DELETE)
auth.use(
  "/*",
  csrf({
    origin: (origin, c) => {
      const appUrl = (c.env as Env).APP_URL?.replace(/\/+$/, "");
      return appUrl ? origin === appUrl : true;
    },
  }),
);

// ─── Session Middleware ──────────────────────────────────

const sessionMw = createMiddleware<SessionAuthEnv>(async (c, next) => {
  try {
    const token = getSessionTokenFromCookie(c, c.env);
    if (!token) return c.json({ error: "Unauthorized" }, 401);

    const tokenHash = await sha256Hex(token);
    const session = await validateSession(c.env.DB, c.env.KV, tokenHash);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    c.set("userId", session.userId);
    c.set("sessionId", session.sessionId);
    c.set("sessionTokenHash", tokenHash);
    await next();
  } catch (err) {
    console.error("Auth error:", err instanceof Error ? err.message : err);
    return c.json({ error: "Internal server error" }, 500, securityHeaders());
  }
});

// ─── Helpers ─────────────────────────────────────────────

function getRedirectUri(c: { req: { url: string }; env: Env }, provider: string, isLink = false): string {
  let origin = c.env.APP_URL?.replace(/\/+$/, "");
  if (!origin) {
    if (c.env.ENVIRONMENT === "development") {
      origin = new URL(c.req.url).origin;
    } else {
      throw new Error("APP_URL environment variable is required in production");
    }
  }
  return isLink
    ? `${origin}/api/v1/auth/link/${provider}/callback`
    : `${origin}/api/v1/auth/${provider}/callback`;
}

function securityHeaders(): Record<string, string> {
  return {
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  };
}

// ─── Session-authenticated routes (static paths first) ───

// GET /session
auth.get("/session", sessionMw, async (c) => {
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
          provider_username: string;
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
            provider_username: p.provider_username,
            provider_email: p.provider_email ?? undefined,
            email_verified: p.email_verified === 1,
            created_at: normalizeDateTime(p.created_at),
          })),
        },
      },
      200,
      { "Cache-Control": "no-store" },
    );
  } catch (err) {
    console.error("Auth error:", err instanceof Error ? err.message : err);
    return c.json({ error: "Internal server error" }, 500, securityHeaders());
  }
});

// DELETE /session (logout)
auth.delete("/session", sessionMw, async (c) => {
  const tokenHash = c.get("sessionTokenHash");
  await invalidateSession(c.env.DB, c.env.KV, tokenHash);
  clearSessionCookie(c, c.env);
  return c.body(null, 204);
});

// GET /sessions (list all active sessions)
auth.get("/sessions", sessionMw, async (c) => {
  try {
    const userId = c.get("userId");
    const currentSessionId = c.get("sessionId");

    const { results } = await c.env.DB.prepare(
      `SELECT id, ip, country, city, user_agent, created_at, expires_at, last_active_at
       FROM sessions WHERE user_id = ? AND expires_at > datetime('now')
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
      200,
      { "Cache-Control": "no-store" },
    );
  } catch (err) {
    console.error("Auth error:", err instanceof Error ? err.message : err);
    return c.json({ error: "Internal server error" }, 500, securityHeaders());
  }
});

// DELETE /sessions (revoke all other sessions)
auth.delete("/sessions", sessionMw, async (c) => {
  const userId = c.get("userId");
  const currentTokenHash = c.get("sessionTokenHash");
  await invalidateOtherSessions(c.env.DB, c.env.KV, userId, currentTokenHash);
  return c.body(null, 204);
});

// DELETE /sessions/:session_id
auth.delete("/sessions/:session_id", sessionMw, async (c) => {
  const userId = c.get("userId");
  const targetSessionId = c.req.param("session_id");
  const currentSessionId = c.get("sessionId");

  // Find the target session (must belong to current user)
  const target = await c.env.DB.prepare(
    "SELECT token_hash FROM sessions WHERE id = ? AND user_id = ?",
  )
    .bind(targetSessionId, userId)
    .first<{ token_hash: string }>();

  if (!target) return c.json({ error: "Not found" }, 404);

  await invalidateSession(c.env.DB, c.env.KV, target.token_hash);

  // If revoking own session, clear cookie
  if (targetSessionId === currentSessionId) {
    clearSessionCookie(c, c.env);
  }

  return c.body(null, 204);
});

// GET /providers (list linked providers)
auth.get("/providers", sessionMw, async (c) => {
  const userId = c.get("userId");

  const { results } = await c.env.DB.prepare(
    "SELECT provider, provider_user_id, provider_username, provider_email, email_verified, created_at FROM oauth_accounts WHERE user_id = ?",
  )
    .bind(userId)
    .all<{
      provider: string;
      provider_user_id: string;
      provider_username: string;
      provider_email: string | null;
      email_verified: number;
      created_at: string;
    }>();

  return c.json({
    data: results.map((p) => ({
      provider: p.provider as OAuthProvider,
      provider_user_id: p.provider_user_id,
      provider_username: p.provider_username,
      provider_email: p.provider_email ?? undefined,
      email_verified: p.email_verified === 1,
      created_at: normalizeDateTime(p.created_at),
    })),
  });
});

// DELETE /providers/:provider (unlink)
auth.delete("/providers/:provider", sessionMw, async (c) => {
  try {
    const userId = c.get("userId");
    const provider = c.req.param("provider");

    if (!isValidProvider(provider)) {
      return c.json({ error: "Invalid provider" }, 400);
    }

    // Ensure user keeps at least one other auth method
    const [{ results: linked }, userRow] = await Promise.all([
      c.env.DB.prepare("SELECT provider FROM oauth_accounts WHERE user_id = ?")
        .bind(userId)
        .all<{ provider: string }>(),
      c.env.DB.prepare("SELECT api_key_hash FROM users WHERE id = ?")
        .bind(userId)
        .first<{ api_key_hash: string | null }>(),
    ]);

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
    console.error("Auth error:", err instanceof Error ? err.message : err);
    return c.json({ error: "Internal server error" }, 500, securityHeaders());
  }
});

// POST /api-key (regenerate)
auth.post("/api-key", sessionMw, async (c) => {
  try {
    const userId = c.get("userId");
    const currentTokenHash = c.get("sessionTokenHash");

    // Get current api_key_hash to clear KV cache
    const user = await c.env.DB.prepare("SELECT api_key_hash FROM users WHERE id = ?")
      .bind(userId)
      .first<{ api_key_hash: string }>();

    if (!user) return c.json({ error: "Unauthorized" }, 401);

    const { plaintext, hash } = await generateApiKey();

    // Batch: update key + delete old KV cache
    await c.env.DB.prepare("UPDATE users SET api_key_hash = ?, modified_at = datetime('now') WHERE id = ?")
      .bind(hash, userId)
      .run();

    await Promise.all([
      c.env.KV.delete(`apikey:${user.api_key_hash}`),
      invalidateOtherSessions(c.env.DB, c.env.KV, userId, currentTokenHash),
    ]);

    return c.json(
      { data: { api_key: plaintext } },
      200,
      { "Cache-Control": "no-store" },
    );
  } catch (err) {
    console.error("Auth error:", err instanceof Error ? err.message : err);
    return c.json({ error: "Internal server error" }, 500, securityHeaders());
  }
});

// POST /link/approve/:pending_link_id
auth.post("/link/approve/:pending_link_id", sessionMw, async (c) => {
  const userId = c.get("userId");
  const pendingLinkId = c.req.param("pending_link_id");

  const pending = await c.env.DB.prepare(
    "SELECT * FROM pending_links WHERE id = ? AND existing_user_id = ?",
  )
    .bind(pendingLinkId, userId)
    .first<{
      id: string;
      existing_user_id: string;
      provider: string;
      provider_user_id: string;
      provider_username: string | null;
      provider_email: string | null;
      email_verified: number;
      access_token_encrypted: string | null;
      refresh_token_encrypted: string | null;
      token_expires_at: string | null;
      expires_at: string;
    }>();

  if (!pending) return c.json({ error: "Not found" }, 404);

  // Check expiry
  const expiresAt = new Date(pending.expires_at.replace(" ", "T") + "Z");
  if (new Date() > expiresAt) {
    await c.env.DB.prepare("DELETE FROM pending_links WHERE id = ?").bind(pendingLinkId).run();
    return c.json({ error: "Pending link expired" }, 410);
  }

  const oauthId = crypto.randomUUID();

  // Create oauth_account + delete pending_link in batch
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, provider_username, provider_email, email_verified, access_token_encrypted, refresh_token_encrypted, token_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      oauthId,
      userId,
      pending.provider,
      pending.provider_user_id,
      pending.provider_username,
      pending.provider_email,
      pending.email_verified,
      pending.access_token_encrypted,
      pending.refresh_token_encrypted,
      pending.token_expires_at,
    ),
    c.env.DB.prepare("DELETE FROM pending_links WHERE id = ?").bind(pendingLinkId),
  ]);

  const userRow = await c.env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
    .bind(userId)
    .first<UserRow>();

  if (!userRow) return c.json({ error: "Unauthorized" }, 401);

  return c.json({ data: { user: rowToUser(userRow) } });
});

// POST /link/:provider (initiate linking)
auth.post("/link/:provider", sessionMw, async (c) => {
  const provider = c.req.param("provider");
  if (!isValidProvider(provider)) return c.json({ error: "Invalid provider" }, 400);

  const userId = c.get("userId");
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();
  const nonce = provider === "google" ? generateNonce() : undefined;

  const redirectUri = getRedirectUri(c, provider, true);
  const authorizeUrl = buildAuthorizeUrl(provider, c.env, redirectUri, codeChallenge, state, nonce);

  await storeOAuthState(c.env.KV, state, { codeVerifier, nonce, linkUserId: userId });
  setStateCookie(c, state, c.env);

  return c.redirect(authorizeUrl, 302);
});

// GET /link/:provider/callback (link callback — read session from cookie manually)
auth.get("/link/:provider/callback", async (c) => {
  const provider = c.req.param("provider");
  if (!isValidProvider(provider)) return c.json({ error: "Invalid provider" }, 400);

  // Handle OAuth error (e.g., user denied access)
  const oauthError = c.req.query("error");
  if (oauthError) {
    console.error(`OAuth error from ${provider}: ${oauthError}`);
    return c.json({ error: "OAuth authorization failed" }, 400, securityHeaders());
  }

  // Validate state (double-submit)
  const stateParam = c.req.query("state");
  const code = c.req.query("code");
  const stateCookie = getStateCookie(c, c.env);
  clearStateCookie(c, c.env);

  if (!stateParam || !code || !stateCookie) {
    return c.json({ error: "Missing state or code" }, 400, securityHeaders());
  }

  if (!(await timingSafeEqual(stateParam, stateCookie))) {
    return c.json({ error: "State mismatch" }, 400, securityHeaders());
  }

  const stateData = await consumeOAuthState(c.env.KV, stateParam);
  if (!stateData || !stateData.linkUserId) {
    return c.json({ error: "Invalid or expired state" }, 400, securityHeaders());
  }

  // Validate session from cookie
  const token = getSessionTokenFromCookie(c, c.env);
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  const tokenHash = await sha256Hex(token);
  const session = await validateSession(c.env.DB, c.env.KV, tokenHash);
  if (!session || session.userId !== stateData.linkUserId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const redirectUri = getRedirectUri(c, provider, true);
    const tokenResponse = await exchangeCode(provider, code, stateData.codeVerifier, redirectUri, c.env);
    const userInfo = await fetchUserInfo(provider, tokenResponse, c.env, c.env.KV, stateData.nonce);

    // Email verification gate (same as login callback)
    if (!userInfo.emailVerified) {
      return c.json(
        { error: "Email not verified with provider. Please verify your email first." },
        400,
        securityHeaders(),
      );
    }

    // Check if this provider account is already linked to a different user
    const existingLink = await c.env.DB.prepare(
      "SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?",
    )
      .bind(provider, userInfo.providerUserId)
      .first<{ user_id: string }>();

    if (existingLink && existingLink.user_id !== stateData.linkUserId) {
      return c.json({ error: "This provider account is already linked to another user" }, 409);
    }

    // Encrypt tokens with AAD context (binds ciphertext to this user+provider)
    const encCtx = `${stateData.linkUserId}:${provider}`;
    const accessTokenEnc = await encryptToken(userInfo.accessToken, c.env.ENCRYPTION_KEY, encCtx);
    const refreshTokenEnc = userInfo.refreshToken
      ? await encryptToken(userInfo.refreshToken, c.env.ENCRYPTION_KEY, encCtx)
      : null;

    if (existingLink) {
      // Update existing link
      await c.env.DB.prepare(
        `UPDATE oauth_accounts SET provider_username = ?, provider_email = ?, email_verified = ?,
         access_token_encrypted = ?, refresh_token_encrypted = ?, token_expires_at = ?
         WHERE provider = ? AND provider_user_id = ?`,
      )
        .bind(
          userInfo.providerUsername,
          userInfo.providerEmail,
          userInfo.emailVerified ? 1 : 0,
          accessTokenEnc,
          refreshTokenEnc,
          userInfo.tokenExpiresAt,
          provider,
          userInfo.providerUserId,
        )
        .run();
    } else {
      // Create new link
      await c.env.DB.prepare(
        `INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, provider_username, provider_email, email_verified, access_token_encrypted, refresh_token_encrypted, token_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          stateData.linkUserId,
          provider,
          userInfo.providerUserId,
          userInfo.providerUsername,
          userInfo.providerEmail,
          userInfo.emailVerified ? 1 : 0,
          accessTokenEnc,
          refreshTokenEnc,
          userInfo.tokenExpiresAt,
        )
        .run();
    }

    return c.json(
      { data: { provider, provider_username: userInfo.providerUsername } },
      200,
      securityHeaders(),
    );
  } catch (err) {
    console.error("Auth error:", err instanceof Error ? err.message : err);
    return c.json({ error: "Internal server error" }, 500, securityHeaders());
  }
});

// ─── Public routes (parameterized, last) ─────────────────

// GET /:provider (initiate OAuth login)
auth.get("/:provider", async (c) => {
  const provider = c.req.param("provider");
  if (!isValidProvider(provider)) return c.json({ error: "Invalid provider" }, 400);

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();
  const nonce = provider === "google" ? generateNonce() : undefined;

  const redirectUri = getRedirectUri(c, provider);
  const authorizeUrl = buildAuthorizeUrl(provider, c.env, redirectUri, codeChallenge, state, nonce);

  await storeOAuthState(c.env.KV, state, { codeVerifier, nonce });
  setStateCookie(c, state, c.env);

  return c.redirect(authorizeUrl, 302);
});

// GET /:provider/callback (OAuth callback — most complex)
auth.get("/:provider/callback", async (c) => {
  const provider = c.req.param("provider");
  if (!isValidProvider(provider)) return c.json({ error: "Invalid provider" }, 400);

  // Handle OAuth error (e.g., user denied access)
  const oauthError = c.req.query("error");
  if (oauthError) {
    console.error(`OAuth error from ${provider}: ${oauthError}`);
    return c.json({ error: "OAuth authorization failed" }, 400, securityHeaders());
  }

  // 1. Validate state (double-submit)
  const stateParam = c.req.query("state");
  const code = c.req.query("code");
  const stateCookie = getStateCookie(c, c.env);
  clearStateCookie(c, c.env);

  if (!stateParam || !code || !stateCookie) {
    return c.json({ error: "Missing state or code" }, 400, securityHeaders());
  }

  if (!(await timingSafeEqual(stateParam, stateCookie))) {
    return c.json({ error: "State mismatch" }, 400, securityHeaders());
  }

  const stateData = await consumeOAuthState(c.env.KV, stateParam);
  if (!stateData) {
    return c.json({ error: "Invalid or expired state" }, 400, securityHeaders());
  }

  try {
    // 2. Exchange code for tokens
    const redirectUri = getRedirectUri(c, provider);
    const tokenResponse = await exchangeCode(provider, code, stateData.codeVerifier, redirectUri, c.env);

    // 3. Fetch/validate user info
    const userInfo = await fetchUserInfo(provider, tokenResponse, c.env, c.env.KV, stateData.nonce);

    // 4. Email verification gate
    if (!userInfo.emailVerified) {
      return c.json({ error: "Email not verified with provider. Please verify your email first." }, 400);
    }

    // 5. Account matching — check for existing OAuth link
    const existingOAuth = await c.env.DB.prepare(
      "SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?",
    )
      .bind(provider, userInfo.providerUserId)
      .first<{ user_id: string }>();

    if (existingOAuth) {
      // ─── Existing user login ─────────────────────
      const encCtx = `${existingOAuth.user_id}:${provider}`;
      const accessTokenEnc = await encryptToken(userInfo.accessToken, c.env.ENCRYPTION_KEY, encCtx);
      const refreshTokenEnc = userInfo.refreshToken
        ? await encryptToken(userInfo.refreshToken, c.env.ENCRYPTION_KEY, encCtx)
        : null;

      // Update provider tokens
      await c.env.DB.prepare(
        `UPDATE oauth_accounts SET provider_username = ?, provider_email = ?, email_verified = ?,
         access_token_encrypted = ?, refresh_token_encrypted = ?, token_expires_at = ?
         WHERE provider = ? AND provider_user_id = ?`,
      )
        .bind(
          userInfo.providerUsername,
          userInfo.providerEmail,
          userInfo.emailVerified ? 1 : 0,
          accessTokenEnc,
          refreshTokenEnc,
          userInfo.tokenExpiresAt,
          provider,
          userInfo.providerUserId,
        )
        .run();

      // Create session
      const sessionToken = generateSessionToken();
      const sessionTokenHash = await sha256Hex(sessionToken);
      await createSession(c.env.DB, existingOAuth.user_id, sessionTokenHash, c.req.raw);
      setSessionCookie(c, sessionToken, c.env);

      const userRow = await c.env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
        .bind(existingOAuth.user_id)
        .first<UserRow>();

      if (!userRow) return c.json({ error: "User not found" }, 500);

      return c.json(
        { data: { user: rowToUser(userRow), is_new_user: false } },
        200,
        securityHeaders(),
      );
    }

    // No existing OAuth link — check if email matches an existing user
    if (userInfo.providerEmail) {
      const emailMatch = await c.env.DB.prepare("SELECT id, username FROM users WHERE email = ?")
        .bind(userInfo.providerEmail)
        .first<{ id: string; username: string }>();

      if (emailMatch) {
        // Limit active pending links per user
        const activeLinkCount = await c.env.DB.prepare(
          "SELECT COUNT(*) as count FROM pending_links WHERE existing_user_id = ? AND expires_at > datetime('now')",
        )
          .bind(emailMatch.id)
          .first<{ count: number }>();
        if (activeLinkCount && activeLinkCount.count >= 3) {
          return c.json({ error: "Too many pending link requests" }, 429);
        }

        // Encrypt tokens with AAD context
        const encCtx = `${emailMatch.id}:${provider}`;
        const accessTokenEnc = await encryptToken(userInfo.accessToken, c.env.ENCRYPTION_KEY, encCtx);
        const refreshTokenEnc = userInfo.refreshToken
          ? await encryptToken(userInfo.refreshToken, c.env.ENCRYPTION_KEY, encCtx)
          : null;

        // Create pending link for manual approval
        const pendingId = crypto.randomUUID();
        const pendingExpiry = new Date(Date.now() + 3600_000) // 1 hour
          .toISOString()
          .replace("T", " ")
          .replace("Z", "");

        await c.env.DB.prepare(
          `INSERT INTO pending_links (id, existing_user_id, provider, provider_user_id, provider_username, provider_email, email_verified, access_token_encrypted, refresh_token_encrypted, token_expires_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            pendingId,
            emailMatch.id,
            provider,
            userInfo.providerUserId,
            userInfo.providerUsername,
            userInfo.providerEmail,
            userInfo.emailVerified ? 1 : 0,
            accessTokenEnc,
            refreshTokenEnc,
            userInfo.tokenExpiresAt,
            pendingExpiry,
          )
          .run();

        // Return minimal pending link info (no full user profile — unauthenticated response)
        return c.json(
          {
            data: {
              pending_link: {
                id: pendingId,
                provider: provider as OAuthProvider,
                provider_username: userInfo.providerUsername,
                provider_email: userInfo.providerEmail!,
                expires_at: normalizeDateTime(pendingExpiry),
              },
            },
          },
          200,
          securityHeaders(),
        );
      }
    }

    // No existing account — new user creation
    const isSingleUser = c.env.INSTANCE_MODE !== "multi";
    const userId = crypto.randomUUID();
    const { plaintext: apiKeyPlaintext, hash: apiKeyHash } = await generateApiKey();

    let username = userInfo.providerUsername.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || `user_${userId.slice(0, 8)}`;

    // Handle username collision by appending random suffix
    const existingUsername = await c.env.DB.prepare("SELECT 1 FROM users WHERE username = ?")
      .bind(username)
      .first();
    if (existingUsername) {
      username = `${username.slice(0, 55)}_${userId.slice(0, 8)}`;
    }

    // Encrypt tokens with AAD context
    const encCtx = `${userId}:${provider}`;
    const accessTokenEnc = await encryptToken(userInfo.accessToken, c.env.ENCRYPTION_KEY, encCtx);
    const refreshTokenEnc = userInfo.refreshToken
      ? await encryptToken(userInfo.refreshToken, c.env.ENCRYPTION_KEY, encCtx)
      : null;

    const oauthAccountId = crypto.randomUUID();

    if (isSingleUser) {
      // Atomic: create user only if no users exist (prevents TOCTOU race)
      const batchResult = await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO users (id, username, email, api_key_hash, created_at, modified_at)
           SELECT ?, ?, ?, ?, datetime('now'), datetime('now')
           WHERE (SELECT COUNT(*) FROM users) = 0`,
        ).bind(userId, username, userInfo.providerEmail, apiKeyHash),
        c.env.DB.prepare(
          `INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, provider_username, provider_email, email_verified, access_token_encrypted, refresh_token_encrypted, token_expires_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)`,
        ).bind(
          oauthAccountId,
          userId,
          provider,
          userInfo.providerUserId,
          userInfo.providerUsername,
          userInfo.providerEmail,
          userInfo.emailVerified ? 1 : 0,
          accessTokenEnc,
          refreshTokenEnc,
          userInfo.tokenExpiresAt,
          userId,
        ),
      ]);

      if (batchResult[0].meta.changes === 0) {
        return c.json(
          { error: "Registration closed. This instance only allows one user." },
          403,
        );
      }
    } else {
      // Multi-user mode: unconditional insert
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT INTO users (id, username, email, api_key_hash, created_at, modified_at)
           VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
        ).bind(userId, username, userInfo.providerEmail, apiKeyHash),
        c.env.DB.prepare(
          `INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, provider_username, provider_email, email_verified, access_token_encrypted, refresh_token_encrypted, token_expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          oauthAccountId,
          userId,
          provider,
          userInfo.providerUserId,
          userInfo.providerUsername,
          userInfo.providerEmail,
          userInfo.emailVerified ? 1 : 0,
          accessTokenEnc,
          refreshTokenEnc,
          userInfo.tokenExpiresAt,
        ),
      ]);
    }

    // Create session
    const sessionToken = generateSessionToken();
    const sessionTokenHash = await sha256Hex(sessionToken);
    await createSession(c.env.DB, userId, sessionTokenHash, c.req.raw);
    setSessionCookie(c, sessionToken, c.env);

    const userRow = await c.env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
      .bind(userId)
      .first<UserRow>();

    if (!userRow) return c.json({ error: "Internal server error" }, 500);

    return c.json(
      {
        data: {
          user: rowToUser(userRow),
          api_key: apiKeyPlaintext,
          is_new_user: true,
        },
      },
      200,
      securityHeaders(),
    );
  } catch (err) {
    console.error("Auth error:", err instanceof Error ? err.message : err);
    return c.json({ error: "Internal server error" }, 500, securityHeaders());
  }
});

export default auth;
