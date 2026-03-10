/**
 * Account linking flow — 3 endpoints.
 * POST /link/:provider — initiate linking (session required)
 * GET /link/:provider/callback — handle link callback
 * POST /link/approve/:pending_link_id — approve pending link
 */
import { Hono } from "hono";
import type { SessionAuthEnv } from "../../types";
import {
  sha256Hex,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  generateNonce,
  encryptToken,
  timingSafeEqual,
} from "../../utils/crypto";
import {
  isValidProvider,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserInfo,
} from "../../utils/oauth";
import {
  validateSession,
  storeOAuthState,
  consumeOAuthState,
  getSessionTokenFromCookie,
  setStateCookie,
  getStateCookie,
  clearStateCookie,
} from "../../utils/session";
import { type UserRow, USER_COLUMNS, rowToUser, normalizeDateTime } from "../../utils/user";
import { sessionMw } from "./middleware";
import { getRedirectUri, securityHeaders } from "./helpers";

const link = new Hono<SessionAuthEnv>();

// POST /link/approve/:pending_link_id (session required)
link.post("/link/approve/:pending_link_id", sessionMw, async (c) => {
  try {
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
    const expiresAt = new Date(normalizeDateTime(pending.expires_at));
    if (new Date() > expiresAt) {
      await c.env.DB.prepare("DELETE FROM pending_links WHERE id = ?").bind(pendingLinkId).run();
      return c.json({ error: "Pending link expired" }, 410);
    }

    const oauthId = crypto.randomUUID();

    // Create oauth_account + delete pending_link in batch
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, provider_username, provider_email, email_verified, access_token_encrypted, refresh_token_encrypted, token_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, provider_user_id) DO UPDATE SET
           provider_username = excluded.provider_username,
           provider_email = excluded.provider_email,
           email_verified = excluded.email_verified,
           access_token_encrypted = excluded.access_token_encrypted,
           refresh_token_encrypted = excluded.refresh_token_encrypted,
           token_expires_at = excluded.token_expires_at`,
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

    return c.json({ data: { user: rowToUser(userRow) } }, 200, securityHeaders());
  } catch (err) {
    console.error("Auth error:", err instanceof Error ? err.message : "Unknown error");
    return c.json({ error: "Internal server error" }, 500, securityHeaders());
  }
});

// POST /link/:provider (initiate linking — session required)
link.post("/link/:provider", sessionMw, async (c) => {
  const provider = c.req.param("provider");
  if (!isValidProvider(provider)) return c.json({ error: "Invalid provider" }, 400, securityHeaders());

  try {
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
  } catch (err) {
    console.error("Link start error:", err instanceof Error ? err.message : "Unknown error");
    return c.json({ error: "Internal server error" }, 500, securityHeaders());
  }
});

// GET /link/:provider/callback (link callback — read session from cookie manually)
link.get("/link/:provider/callback", async (c) => {
  const provider = c.req.param("provider");
  if (!isValidProvider(provider)) return c.json({ error: "Invalid provider" }, 400, securityHeaders());

  // Handle OAuth error (e.g., user denied access)
  const oauthError = c.req.query("error");
  if (oauthError) {
    const sanitized = oauthError.replace(/[\r\n]/g, "").slice(0, 100);
    console.error(`OAuth link error from ${provider}: ${sanitized}`);
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
  if (code.length > 2048) {
    return c.json({ error: "Invalid code" }, 400, securityHeaders());
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
  if (!token) return c.json({ error: "Unauthorized" }, 401, securityHeaders());
  const tokenHash = await sha256Hex(token);
  const session = await validateSession(c.env.DB, c.env.KV, tokenHash);
  if (!session || session.userId !== stateData.linkUserId) {
    return c.json({ error: "Unauthorized" }, 401, securityHeaders());
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
      return c.json({ error: "This provider account is already linked to another user" }, 409, securityHeaders());
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
    console.error("Link callback error:", err instanceof Error ? err.message : "Unknown error");
    return c.json({ error: "Internal server error" }, 500, securityHeaders());
  }
});

export default link;
