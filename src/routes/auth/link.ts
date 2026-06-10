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
import { rateLimitExceeded, tooManyRequests } from "../../middleware/rate-limit";
import { type UserRow, USER_COLUMNS, rowToUser, normalizeDateTime } from "../../utils/user";
import { sessionMw } from "./middleware";
import { getRedirectUri, noCacheHeaders } from "./helpers";

// Verification tokens are base64url(randomBytes(32)) — exactly 43 url-safe
// characters (see generateVerificationToken). Rejecting anything else before
// hashing keeps this unauthenticated route from issuing D1 queries for
// arbitrary garbage input (Issue #152).
const VERIFY_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const VERIFY_SUCCESS_HTML =
  `<!doctype html><html><head><meta charset="utf-8"><title>Email verified — CloudTime</title></head>` +
  `<body><h1>Email verified</h1>` +
  `<p>Thanks. Return to CloudTime and approve the account merge from your account settings.</p>` +
  `</body></html>`;

const link = new Hono<SessionAuthEnv>();

// GET /link/verify/:token (public — out-of-band PendingLink verification, Issue #80).
// The token in the URL is the only proof; first hit consumes it via UPDATE-
// with-RETURNING. CSRF middleware is bypassed for this path (see src/index.ts)
// so non-GET methods reach the route layer and receive a clean 405.
link.all("/link/verify/:token", async (c) => {
  if (c.req.method !== "GET") {
    return c.json({ error: "Method Not Allowed" }, 405, {
      Allow: "GET",
      "Cache-Control": "no-store",
    });
  }

  // Edge rate limit (Issue #159): after the free 405 branch — method probes
  // must not consume the budget of a user's real click — and before any
  // mode/token processing so rejected requests cost no D1 work.
  if (await rateLimitExceeded(c.env.RATE_LIMIT_LINK_VERIFY, c.req.raw.headers, "link-verify", "RATE_LIMIT_LINK_VERIFY")) {
    return tooManyRequests(c);
  }

  if (c.env.INSTANCE_MODE !== "multi") {
    return c.json({ error: "Token not found" }, 410, noCacheHeaders());
  }

  const token = c.req.param("token");
  if (!token || !VERIFY_TOKEN_RE.test(token)) {
    return c.json({ error: "Token not found" }, 410, noCacheHeaders());
  }
  let tokenHash: string;
  try {
    tokenHash = await sha256Hex(token);
  } catch {
    return c.json({ error: "Token not found" }, 410, noCacheHeaders());
  }

  // Atomic single-use consumption: only flip email_verified_at when the row
  // exists, hasn't been verified yet, and hasn't expired. `meta.changes`
  // distinguishes the success path from the various 410 cases.
  const result = await c.env.DB.prepare(
    `UPDATE pending_links
       SET email_verified_at = datetime('now')
     WHERE email_verification_token_hash = ?
       AND email_verified_at IS NULL
       AND expires_at > datetime('now')
     RETURNING id`,
  )
    .bind(tokenHash)
    .first<{ id: string }>();

  if (result) {
    return c.body(VERIFY_SUCCESS_HTML, 200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    });
  }

  // Distinguish replay vs expiry vs not-found for clearer logs and bodies.
  // SELECT after the failed UPDATE is two queries on the cold path only.
  const existing = await c.env.DB.prepare(
    `SELECT email_verified_at, expires_at FROM pending_links
     WHERE email_verification_token_hash = ?`,
  )
    .bind(tokenHash)
    .first<{ email_verified_at: string | null; expires_at: string }>();

  if (!existing) {
    return c.json({ error: "Token not found" }, 410, noCacheHeaders());
  }
  if (existing.email_verified_at !== null) {
    return c.json({ error: "Token already used" }, 410, noCacheHeaders());
  }
  return c.json({ error: "Token expired" }, 410, noCacheHeaders());
});

// POST /link/approve/:pending_link_id (session required)
link.post("/link/approve/:pending_link_id", sessionMw, async (c) => {
  try {
    const userId = c.get("userId");
    const pendingLinkId = c.req.param("pending_link_id");

    const pending = await c.env.DB.prepare(
      `SELECT provider, provider_user_id, provider_username, provider_email,
              email_verified, access_token_encrypted, refresh_token_encrypted,
              token_expires_at, expires_at,
              email_verification_token_hash, email_verified_at
       FROM pending_links WHERE id = ? AND existing_user_id = ?`,
    )
      .bind(pendingLinkId, userId)
      .first<{
        provider: string;
        provider_user_id: string;
        provider_username: string | null;
        provider_email: string | null;
        email_verified: number;
        access_token_encrypted: string | null;
        refresh_token_encrypted: string | null;
        token_expires_at: string | null;
        expires_at: string;
        email_verification_token_hash: string | null;
        email_verified_at: string | null;
      }>();

    if (!pending) return c.json({ error: "Not found" }, 404, noCacheHeaders());

    // Check expiry
    const expiresAt = new Date(normalizeDateTime(pending.expires_at));
    if (new Date() > expiresAt) {
      await c.env.DB.prepare("DELETE FROM pending_links WHERE id = ?").bind(pendingLinkId).run();
      return c.json({ error: "Pending link expired" }, 410, noCacheHeaders());
    }

    // Out-of-band email verification gate (Issue #80). Rows created under the
    // new flow carry a token hash; the recipient must have clicked the email
    // link to set email_verified_at. Rows pre-dating the feature (NULL hash)
    // also fail this check — they must be re-triggered via OAuth, and
    // expire naturally within 1 hour.
    if (pending.email_verified_at === null) {
      return c.json(
        { error: "Email verification required" },
        403,
        noCacheHeaders(),
      );
    }

    // Check if this provider account was linked to another user in the meantime
    const existingLink = await c.env.DB.prepare(
      "SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?",
    )
      .bind(pending.provider, pending.provider_user_id)
      .first<{ user_id: string }>();

    if (existingLink && existingLink.user_id !== userId) {
      await c.env.DB.prepare("DELETE FROM pending_links WHERE id = ?").bind(pendingLinkId).run();
      return c.json(
        { error: "This provider account is already linked to another user" },
        409,
        noCacheHeaders(),
      );
    }

    const oauthId = crypto.randomUUID();

    // Create oauth_account + delete pending_link + optionally set email_verified
    const batchStmts = [
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
    ];

    // FR-006: Propagate email_verified from approved provider to user account
    if (pending.email_verified === 1) {
      batchStmts.push(
        c.env.DB.prepare(
          `UPDATE users SET email_verified = 1, modified_at = datetime('now') WHERE id = ? AND email_verified = 0`,
        ).bind(userId),
      );
    }

    await c.env.DB.batch(batchStmts);

    const userRow = await c.env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
      .bind(userId)
      .first<UserRow>();

    if (!userRow) return c.json({ error: "Unauthorized" }, 401);

    return c.json({ data: { user: rowToUser(userRow) } }, 200, noCacheHeaders());
  } catch (err) {
    console.error("Auth error:", err instanceof Error ? err.message : "Unknown error");
    return c.json({ error: "Internal server error" }, 500, noCacheHeaders());
  }
});

// POST /link/:provider (initiate linking — session required)
link.post("/link/:provider", sessionMw, async (c) => {
  const provider = c.req.param("provider");
  if (!isValidProvider(provider)) return c.json({ error: "Invalid provider" }, 400, noCacheHeaders());

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
    return c.json({ error: "Internal server error" }, 500, noCacheHeaders());
  }
});

// GET /link/:provider/callback (link callback — read session from cookie manually)
link.get("/link/:provider/callback", async (c) => {
  const provider = c.req.param("provider");
  if (!isValidProvider(provider)) return c.json({ error: "Invalid provider" }, 400, noCacheHeaders());

  // Handle OAuth error (e.g., user denied access)
  const oauthError = c.req.query("error");
  if (oauthError) {
    const sanitized = oauthError.replace(/[\r\n]/g, "").slice(0, 100);
    console.error(`OAuth link error from ${provider}: ${sanitized}`);
    return c.json({ error: "OAuth authorization failed" }, 400, noCacheHeaders());
  }

  // Validate state (double-submit)
  const stateParam = c.req.query("state");
  const code = c.req.query("code");
  const stateCookie = getStateCookie(c, c.env);
  clearStateCookie(c, c.env);

  if (!stateParam || !code || !stateCookie) {
    return c.json({ error: "Missing state or code" }, 400, noCacheHeaders());
  }
  if (code.length > 2048) {
    return c.json({ error: "Invalid code" }, 400, noCacheHeaders());
  }

  if (!(await timingSafeEqual(stateParam, stateCookie))) {
    return c.json({ error: "State mismatch" }, 400, noCacheHeaders());
  }

  const stateData = await consumeOAuthState(c.env.KV, stateParam);
  if (!stateData || !stateData.linkUserId) {
    return c.json({ error: "Invalid or expired state" }, 400, noCacheHeaders());
  }

  // Validate session from cookie
  const token = getSessionTokenFromCookie(c, c.env);
  if (!token) return c.json({ error: "Unauthorized" }, 401, noCacheHeaders());
  const tokenHash = await sha256Hex(token);
  const session = await validateSession(c.env.DB, c.env.KV, tokenHash);
  if (!session || session.userId !== stateData.linkUserId) {
    return c.json({ error: "Unauthorized" }, 401, noCacheHeaders());
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
        noCacheHeaders(),
      );
    }

    // Check if this provider account is already linked to a different user
    const existingLink = await c.env.DB.prepare(
      "SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?",
    )
      .bind(provider, userInfo.providerUserId)
      .first<{ user_id: string }>();

    if (existingLink && existingLink.user_id !== stateData.linkUserId) {
      return c.json({ error: "This provider account is already linked to another user" }, 409, noCacheHeaders());
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
      noCacheHeaders(),
    );
  } catch (err) {
    console.error("Link callback error:", err instanceof Error ? err.message : "Unknown error");
    return c.json({ error: "Internal server error" }, 500, noCacheHeaders());
  }
});

export default link;
