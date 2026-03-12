/**
 * OAuth provider configurations, token exchange, and user info fetching.
 */
import * as jose from "jose";
import type { Env } from "../types";

// ─── Validation ──────────────────────────────────────────

export class OAuthValidationError extends Error {
  constructor(context: string) {
    super(`OAuth validation failed: ${context}`);
    this.name = "OAuthValidationError";
  }
}

// ─── Types ───────────────────────────────────────────────

export type OAuthProvider = "github" | "google" | "discord";

const VALID_PROVIDERS = new Set<string>(["github", "google", "discord"]);

export function isValidProvider(s: string): s is OAuthProvider {
  return VALID_PROVIDERS.has(s);
}

export interface ProviderUserInfo {
  providerUserId: string;
  providerUsername: string;
  providerEmail: string | null;
  emailVerified: boolean;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
}

// ─── Authorization URLs ──────────────────────────────────

/** Timeout for all outbound OAuth/provider HTTP requests. */
const FETCH_TIMEOUT = 10_000;

/** Shared fetch options for outbound provider requests (SSRF defense-in-depth). */
const PROVIDER_FETCH_OPTS = {
  redirect: "error" as const,
  get signal(): AbortSignal {
    return AbortSignal.timeout(FETCH_TIMEOUT);
  },
};

/**
 * Validate that redirectUri matches the configured APP_URL origin.
 * Prevents Open Redirect / Authorization Code Interception when the caller
 * constructs redirectUri from the request Host header (RFC 9700).
 */
function validateRedirectUri(redirectUri: string, env: Env): void {
  if (!env.APP_URL) return;

  let appOrigin: string;
  let redirectOrigin: string;
  try {
    appOrigin = new URL(env.APP_URL).origin;
    redirectOrigin = new URL(redirectUri).origin;
  } catch {
    throw new Error("Invalid redirect_uri");
  }

  if (redirectOrigin !== appOrigin) {
    throw new Error("redirect_uri does not match APP_URL origin");
  }
}

export function buildAuthorizeUrl(
  provider: OAuthProvider,
  env: Env,
  redirectUri: string,
  codeChallenge: string,
  state: string,
  nonce: string,
): string {
  validateRedirectUri(redirectUri, env);

  switch (provider) {
    case "github": {
      // NOTE: PKCE (code_challenge) is only enforced by GitHub Apps, not OAuth Apps.
      // GitHub OAuth Apps silently ignore these parameters.
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "read:user user:email");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    }
    case "google": {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "openid email profile");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("nonce", nonce);
      return url.toString();
    }
    case "discord": {
      const url = new URL("https://discord.com/oauth2/authorize");
      url.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", "identify email");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      return url.toString();
    }
  }
}

// ─── Assertion Functions ─────────────────────────────────

interface TokenResponse {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
}

interface TokenErrorResponse {
  error: string;
  error_description?: string;
}

type TokenExchangeResult = TokenResponse | TokenErrorResponse;

function assertTokenExchangeResult(
  data: unknown,
): asserts data is TokenExchangeResult {
  if (typeof data !== "object" || data === null) {
    throw new OAuthValidationError("token response is not an object");
  }
  const obj = data as Record<string, unknown>;

  // Check for provider error responses first (GitHub returns 200 with error field)
  if (typeof obj.error === "string") return;

  if (typeof obj.access_token !== "string" || obj.access_token === "") {
    throw new OAuthValidationError("token response missing access_token");
  }
  if (typeof obj.token_type !== "string" || obj.token_type === "") {
    throw new OAuthValidationError("token response missing token_type");
  }
  if (obj.refresh_token !== undefined && typeof obj.refresh_token !== "string") {
    throw new OAuthValidationError("token response refresh_token is not a string");
  }
  if (obj.expires_in !== undefined && typeof obj.expires_in !== "number") {
    throw new OAuthValidationError("token response expires_in is not a number");
  }
  if (obj.id_token !== undefined && typeof obj.id_token !== "string") {
    throw new OAuthValidationError("token response id_token is not a string");
  }
  if (obj.scope !== undefined && typeof obj.scope !== "string") {
    throw new OAuthValidationError("token response scope is not a string");
  }
}

function isTokenError(result: TokenExchangeResult): result is TokenErrorResponse {
  return "error" in result;
}

interface GitHubUser {
  id: number;
  login: string;
}

function assertGitHubUser(data: unknown): asserts data is GitHubUser {
  if (typeof data !== "object" || data === null) {
    throw new OAuthValidationError("GitHub /user response is not an object");
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.id !== "number") {
    throw new OAuthValidationError("GitHub /user id is not a number");
  }
  if (typeof obj.login !== "string" || obj.login === "") {
    throw new OAuthValidationError("GitHub /user login is not a string");
  }
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

function assertGitHubEmails(data: unknown): asserts data is GitHubEmail[] {
  if (!Array.isArray(data)) {
    throw new OAuthValidationError("GitHub /user/emails response is not an array");
  }
  for (const item of data) {
    if (typeof item !== "object" || item === null) {
      throw new OAuthValidationError("GitHub /user/emails entry is not an object");
    }
    const entry = item as Record<string, unknown>;
    if (typeof entry.email !== "string") {
      throw new OAuthValidationError("GitHub /user/emails entry missing email");
    }
    if (typeof entry.primary !== "boolean") {
      throw new OAuthValidationError("GitHub /user/emails entry missing primary");
    }
    if (typeof entry.verified !== "boolean") {
      throw new OAuthValidationError("GitHub /user/emails entry missing verified");
    }
  }
}

interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  email: string | null;
  verified: boolean;
}

function assertDiscordUser(data: unknown): asserts data is DiscordUser {
  if (typeof data !== "object" || data === null) {
    throw new OAuthValidationError("Discord /users/@me response is not an object");
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.id !== "string" || obj.id === "") {
    throw new OAuthValidationError("Discord /users/@me id is not a string");
  }
  if (typeof obj.username !== "string" || obj.username === "") {
    throw new OAuthValidationError("Discord /users/@me username is not a string");
  }
  if (typeof obj.verified !== "boolean") {
    throw new OAuthValidationError("Discord /users/@me verified is not a boolean");
  }
  if (obj.global_name !== null && typeof obj.global_name !== "string") {
    throw new OAuthValidationError("Discord /users/@me global_name is not a string or null");
  }
  if (obj.email !== null && typeof obj.email !== "string") {
    throw new OAuthValidationError("Discord /users/@me email is not a string or null");
  }
}

// ─── Scope Verification ─────────────────────────────────

const REQUIRED_SCOPES: Record<OAuthProvider, string[] | null> = {
  github: ["read:user", "user:email"],
  discord: ["identify", "email"],
  google: null, // OpenID Connect: validated via id_token claims
};

function verifyGrantedScopes(provider: OAuthProvider, scopeField: string | undefined): void {
  const required = REQUIRED_SCOPES[provider];
  if (!required) return;

  if (!scopeField) {
    console.warn(`${provider} token response missing scope field`);
    return; // downstream fetchUserInfo will detect insufficient permissions
  }

  // GitHub uses comma-separated, Discord uses space-separated — handle both
  const granted = new Set(
    scopeField.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
  );
  const missing = required.filter((s) => !granted.has(s));

  if (missing.length > 0) {
    throw new OAuthValidationError(
      `${provider}: required scopes not granted: ${missing.join(", ")}`,
    );
  }
}

// ─── Token Exchange ──────────────────────────────────────

export async function exchangeCode(
  provider: OAuthProvider,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  env: Env,
): Promise<TokenResponse> {
  validateRedirectUri(redirectUri, env);
  const { url, clientId, clientSecret } = getTokenEndpoint(provider, env);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: codeVerifier,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
    ...PROVIDER_FETCH_OPTS,
  });

  const raw: unknown = await res.json();
  assertTokenExchangeResult(raw);

  // GitHub returns 200 even on errors
  if (isTokenError(raw)) {
    console.error(`OAuth token exchange failed for ${provider}: ${raw.error}`);
    throw new Error("OAuth token exchange failed");
  }

  if (!res.ok) {
    throw new Error(`OAuth token exchange failed: HTTP ${res.status}`);
  }

  verifyGrantedScopes(provider, raw.scope);

  return raw;
}

function getTokenEndpoint(
  provider: OAuthProvider,
  env: Env,
): { url: string; clientId: string; clientSecret: string } {
  switch (provider) {
    case "github":
      return {
        url: "https://github.com/login/oauth/access_token",
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      };
    case "google":
      return {
        url: "https://oauth2.googleapis.com/token",
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      };
    case "discord":
      return {
        url: "https://discord.com/api/v10/oauth2/token",
        clientId: env.DISCORD_CLIENT_ID,
        clientSecret: env.DISCORD_CLIENT_SECRET,
      };
  }
}

// ─── User Info Fetching ──────────────────────────────────

export async function fetchUserInfo(
  provider: OAuthProvider,
  tokenResponse: TokenResponse,
  env: Env,
  kv: KVNamespace,
  nonce: string,
): Promise<ProviderUserInfo> {
  const expiresAt = tokenResponse.expires_in
    ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
    : null;

  switch (provider) {
    case "github":
      return fetchGitHubUser(tokenResponse.access_token, tokenResponse.refresh_token ?? null, expiresAt);
    case "google": {
      if (!tokenResponse.id_token) {
        throw new Error("Google OAuth response missing id_token — ensure 'openid' scope is requested");
      }
      return validateGoogleIdToken(
        tokenResponse.id_token,
        tokenResponse.access_token,
        tokenResponse.refresh_token ?? null,
        expiresAt,
        env,
        kv,
        nonce,
      );
    }
    case "discord":
      return fetchDiscordUser(tokenResponse.access_token, tokenResponse.refresh_token ?? null, expiresAt);
  }
}

// ─── GitHub ──────────────────────────────────────────────

async function fetchGitHubUser(
  accessToken: string,
  refreshToken: string | null,
  tokenExpiresAt: string | null,
): Promise<ProviderUserInfo> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "CloudTime/1.0",
  };

  const [userRes, emailsRes] = await Promise.all([
    fetch("https://api.github.com/user", { headers, ...PROVIDER_FETCH_OPTS }),
    fetch("https://api.github.com/user/emails", { headers, ...PROVIDER_FETCH_OPTS }),
  ]);

  if (!userRes.ok) throw new Error(`GitHub /user failed: ${userRes.status}`);
  if (!emailsRes.ok) throw new Error(`GitHub /user/emails failed: ${emailsRes.status}`);

  const user: unknown = await userRes.json();
  assertGitHubUser(user);

  const emails: unknown = await emailsRes.json();
  assertGitHubEmails(emails);

  const primaryEmail = emails.find((e) => e.primary && e.verified);

  return {
    providerUserId: String(user.id),
    providerUsername: user.login,
    providerEmail: primaryEmail?.email ?? null,
    emailVerified: !!primaryEmail,
    accessToken,
    refreshToken,
    tokenExpiresAt,
  };
}

// ─── Google (OpenID Connect) ─────────────────────────────

// Module-level JWKS cache: Workers isolates are reused across requests on the
// same instance, so this serves as a fast in-memory cache layer above KV.
// This is an intentional Workers-specific optimisation — do not store
// per-request data at module scope.
let cachedJWKS: jose.JWTVerifyGetKey | null = null;
let jwksCachedAt = 0;
let lastJwksFetchAt = 0;
let jwksInflight: Promise<jose.JWTVerifyGetKey> | null = null;
const JWKS_MEMORY_TTL = 60_000; // 1 min in-memory, KV has 10min TTL
const JWKS_COOLDOWN = 10_000; // Min interval between Google JWKS fetches

async function getGoogleJWKS(kv: KVNamespace): Promise<jose.JWTVerifyGetKey> {
  // In-memory cache for hot path
  if (cachedJWKS && Date.now() - jwksCachedAt < JWKS_MEMORY_TTL) {
    return cachedJWKS;
  }

  // Try KV cache
  const kvKey = "google:jwks";
  const cached = await kv.get(kvKey);
  if (cached) {
    try {
      const jwks: unknown = JSON.parse(cached);
      // jose.createLocalJWKSet validates internally; cast is safe here
      cachedJWKS = jose.createLocalJWKSet(jwks as jose.JSONWebKeySet);
      jwksCachedAt = Date.now();
      return cachedJWKS;
    } catch {
      await kv.delete(kvKey);
      // Fall through to fetch fresh JWKS
    }
  }

  // Share in-flight fetch across concurrent callers
  if (jwksInflight) return jwksInflight;

  // Cooldown: prevent rapid refetches (e.g. attacker sending tokens with unknown kid)
  if (Date.now() - lastJwksFetchAt < JWKS_COOLDOWN) {
    throw new Error("Google JWKS fetch rate limited — try again shortly");
  }

  // Fetch from Google, sharing the promise with concurrent callers
  lastJwksFetchAt = Date.now();
  jwksInflight = (async () => {
    try {
      const res = await fetch("https://www.googleapis.com/oauth2/v3/certs", PROVIDER_FETCH_OPTS);
      if (!res.ok) throw new Error(`Failed to fetch Google JWKS: ${res.status}`);
      const jwks: unknown = await res.json();

      let keySet: jose.JWTVerifyGetKey;
      try {
        // jose.createLocalJWKSet validates internally; cast is safe here
        keySet = jose.createLocalJWKSet(jwks as jose.JSONWebKeySet);
      } catch {
        throw new OAuthValidationError("Google JWKS response is not a valid JWK Set");
      }

      // Cache in KV (10 min TTL)
      await kv.put(kvKey, JSON.stringify(jwks), { expirationTtl: 600 });
      cachedJWKS = keySet;
      jwksCachedAt = Date.now();
      return cachedJWKS;
    } catch (err) {
      lastJwksFetchAt = 0; // Reset cooldown on failure so next request can retry
      throw err;
    } finally {
      jwksInflight = null;
    }
  })();

  return jwksInflight;
}

async function verifyGoogleJwt(
  idToken: string,
  env: Env,
  kv: KVNamespace,
): Promise<jose.JWTPayload> {
  const verifyOpts: jose.JWTVerifyOptions = {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: env.GOOGLE_CLIENT_ID,
    algorithms: ["RS256"],
    maxTokenAge: "5 minutes",
    clockTolerance: "5 seconds",
  };

  try {
    const jwks = await getGoogleJWKS(kv);
    const { payload } = await jose.jwtVerify(idToken, jwks, verifyOpts);
    return payload;
  } catch (err) {
    // If signature verification fails, Google may have rotated keys — clear cache and retry
    if (
      err instanceof jose.errors.JWSSignatureVerificationFailed ||
      err instanceof jose.errors.JWKSNoMatchingKey
    ) {
      cachedJWKS = null;
      jwksCachedAt = 0;
      lastJwksFetchAt = 0; // Allow immediate retry for legitimate key rotation
      await kv.delete("google:jwks");
      const freshJwks = await getGoogleJWKS(kv);
      const { payload } = await jose.jwtVerify(idToken, freshJwks, verifyOpts);
      return payload;
    }
    throw err;
  }
}

async function validateGoogleIdToken(
  idToken: string,
  accessToken: string,
  refreshToken: string | null,
  tokenExpiresAt: string | null,
  env: Env,
  kv: KVNamespace,
  nonce: string,
): Promise<ProviderUserInfo> {
  const payload = await verifyGoogleJwt(idToken, env, kv);

  // Validate azp (authorized party) when present — prevents cross-client token reuse.
  // In OIDC, azp is typically only included when there are multiple audiences; jose
  // has already validated the aud claim against GOOGLE_CLIENT_ID.
  if (payload.azp && payload.azp !== env.GOOGLE_CLIENT_ID) {
    throw new Error("Google id_token azp mismatch");
  }

  // Validate nonce — always required (replay attack prevention per OIDC Core 1.0)
  if (!payload.nonce) {
    throw new Error("Google id_token missing expected nonce");
  }
  if (payload.nonce !== nonce) {
    throw new Error("Google id_token nonce mismatch");
  }

  // Validate at_hash (access token hash) if present.
  // Assumes RS256 (SHA-256, left 128 bits). Google currently only uses RS256;
  // if they add RS384/RS512 the algorithms restriction above will reject them
  // before reaching this point, so this is safe.
  if (payload.at_hash && typeof payload.at_hash === "string") {
    const atHashBuf = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(accessToken),
    );
    const halfHash = new Uint8Array(atHashBuf.slice(0, 16));
    let binary = "";
    for (const b of halfHash) binary += String.fromCharCode(b);
    const expected = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    if (expected !== payload.at_hash) {
      throw new Error("Google id_token at_hash mismatch");
    }
  }

  if (!payload.sub) {
    throw new Error("Google id_token missing sub claim");
  }

  const email = typeof payload.email === "string" ? payload.email : null;
  const emailVerified = payload.email_verified === true && email !== null;
  const providerUsername =
    (typeof payload.name === "string" && payload.name) || email || payload.sub;

  return {
    providerUserId: payload.sub,
    providerUsername,
    providerEmail: emailVerified ? email : null,
    emailVerified,
    accessToken,
    refreshToken,
    tokenExpiresAt,
  };
}

// ─── Discord ─────────────────────────────────────────────

async function fetchDiscordUser(
  accessToken: string,
  refreshToken: string | null,
  tokenExpiresAt: string | null,
): Promise<ProviderUserInfo> {
  const res = await fetch("https://discord.com/api/v10/users/@me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "CloudTime/1.0",
    },
    ...PROVIDER_FETCH_OPTS,
  });

  if (!res.ok) throw new Error(`Discord /users/@me failed: ${res.status}`);

  const user: unknown = await res.json();
  assertDiscordUser(user);

  return {
    providerUserId: user.id,
    providerUsername: user.global_name || user.username,
    providerEmail: user.verified ? user.email : null,
    emailVerified: user.verified && user.email !== null,
    accessToken,
    refreshToken,
    tokenExpiresAt,
  };
}
