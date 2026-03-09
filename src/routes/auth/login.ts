/**
 * OAuth login flow — 2 endpoints.
 * GET /:provider — initiate OAuth redirect
 * GET /:provider/callback — handle OAuth callback, create user/session
 */
import { Hono } from "hono";
import type { Env } from "../../types";
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
} from "../../utils/crypto";
import {
  isValidProvider,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserInfo,
  type OAuthProvider,
} from "../../utils/oauth";
import {
  createSession,
  storeOAuthState,
  consumeOAuthState,
  setSessionCookie,
  setStateCookie,
  getStateCookie,
  clearStateCookie,
} from "../../utils/session";
import { type UserRow, USER_COLUMNS, rowToUser, normalizeDateTime } from "../../utils/user";
import { getRedirectUri, securityHeaders } from "./helpers";

const login = new Hono<{ Bindings: Env }>();

// GET /:provider (initiate OAuth login)
login.get("/:provider", async (c) => {
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
login.get("/:provider/callback", async (c) => {
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

export default login;
