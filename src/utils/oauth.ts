/**
 * OAuth provider configurations, token exchange, and user info fetching.
 */
import * as jose from "jose";
import { z } from "zod";
import type { Env } from "../types";

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
  if (!env.APP_URL) {
    if (env.ENVIRONMENT === "development") return;
    throw new Error("APP_URL is required for redirect URI validation in non-development environments");
  }

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
  nonce?: string,
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
      if (nonce) url.searchParams.set("nonce", nonce);
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

// ─── Response Schemas (zod) ──────────────────────────────

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  id_token: z.string().optional(),
  scope: z.string().optional(),
});

const tokenErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

type TokenResponse = z.infer<typeof tokenResponseSchema>;

const githubUserSchema = z.object({
  id: z.number(),
  login: z.string(),
});

const githubEmailSchema = z.array(z.object({
  email: z.string(),
  primary: z.boolean(),
  verified: z.boolean(),
}));

const discordUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  global_name: z.string().nullable(),
  email: z.string().nullable(),
  verified: z.boolean().optional(),
});

// ─── Scope Verification ─────────────────────────────────

/**
 * Verify that the OAuth provider granted all required scopes.
 * Google is skipped because its scopes are validated via JWT claims in verifyGoogleIdToken.
 */
function verifyGrantedScopes(provider: string, grantedScope?: string): void {
  const required: Record<string, string[]> = {
    github: ["read:user", "user:email"],
    discord: ["identify", "email"],
  };
  const requiredScopes = required[provider];
  if (!requiredScopes) return; // Google — JWT verification handles scope

  if (!grantedScope) {
    throw new Error(`${provider} did not return granted scopes`);
  }
  const granted = new Set(grantedScope.split(/[\s,]+/));
  const missing = requiredScopes.filter((s) => !granted.has(s));
  if (missing.length > 0) {
    throw new Error(`${provider} denied required scopes: ${missing.join(", ")}`);
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

  const json = await res.json().catch(() => {
    throw new Error(`${provider} token endpoint returned non-JSON response (HTTP ${res.status})`);
  });

  // GitHub returns 200 even on errors — check error field first
  const errorResult = tokenErrorSchema.safeParse(json);
  if (errorResult.success && errorResult.data.error) {
    console.error(`OAuth token exchange failed for ${provider}: ${errorResult.data.error}`);
    throw new Error("OAuth token exchange failed");
  }

  if (!res.ok) {
    throw new Error(`OAuth token exchange failed: HTTP ${res.status}`);
  }

  const result = tokenResponseSchema.safeParse(json);
  if (!result.success) {
    console.error(`${provider} token response validation failed:`, result.error.message);
    throw new Error("OAuth token response has unexpected format");
  }

  verifyGrantedScopes(provider, result.data.scope);

  return result.data;
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
  nonce?: string,
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
      if (!nonce) {
        throw new Error("Nonce is required for Google OAuth");
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

  const userJson = await userRes.json().catch(() => {
    throw new Error("GitHub /user returned non-JSON response");
  });
  const userResult = githubUserSchema.safeParse(userJson);
  if (!userResult.success) {
    console.error("GitHub /user response validation failed:", userResult.error.message);
    throw new Error("Unexpected GitHub /user response format");
  }
  const user = userResult.data;

  const emailsJson = await emailsRes.json().catch(() => {
    throw new Error("GitHub /user/emails returned non-JSON response");
  });
  const emailsResult = githubEmailSchema.safeParse(emailsJson);
  if (!emailsResult.success) {
    console.error("GitHub /user/emails response validation failed:", emailsResult.error.message);
    throw new Error("Unexpected GitHub /user/emails response format");
  }
  const emails = emailsResult.data;

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
      const jwks = JSON.parse(cached) as jose.JSONWebKeySet;
      cachedJWKS = jose.createLocalJWKSet(jwks);
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
      const jwks = (await res.json()) as jose.JSONWebKeySet;

      // Cache in KV (10 min TTL)
      await kv.put(kvKey, JSON.stringify(jwks), { expirationTtl: 600 });
      cachedJWKS = jose.createLocalJWKSet(jwks);
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

// ─── Token Revocation ────────────────────────────────────

export async function revokeProviderToken(
  provider: OAuthProvider,
  accessToken: string,
  refreshToken: string | null,
  env: Env,
): Promise<void> {
  switch (provider) {
    case "github": {
      const res = await fetch(
        `https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/token`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "CloudTime/1.0",
          },
          body: JSON.stringify({ access_token: accessToken }),
          ...PROVIDER_FETCH_OPTS,
        },
      );
      // 422 = already revoked, treat as success
      if (!res.ok && res.status !== 422) {
        console.error(`GitHub token revocation failed: HTTP ${res.status}`);
      }
      break;
    }
    case "google": {
      // Prefer refresh token (revoking it cascades to the access token)
      const token = refreshToken ?? accessToken;
      const res = await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
        ...PROVIDER_FETCH_OPTS,
      });
      if (!res.ok) {
        console.error(`Google token revocation failed: HTTP ${res.status}`);
        // If refresh token revocation failed, also try revoking the access token directly
        if (refreshToken) {
          const fallback = await fetch("https://oauth2.googleapis.com/revoke", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: accessToken }).toString(),
            ...PROVIDER_FETCH_OPTS,
          });
          if (!fallback.ok) {
            console.error(`Google access token revocation also failed: HTTP ${fallback.status}`);
          }
        }
      }
      break;
    }
    case "discord": {
      const revokeOne = async (token: string, hint: string) => {
        const body = new URLSearchParams({
          token,
          token_type_hint: hint,
          client_id: env.DISCORD_CLIENT_ID,
          client_secret: env.DISCORD_CLIENT_SECRET,
        });
        const res = await fetch("https://discord.com/api/v10/oauth2/token/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          ...PROVIDER_FETCH_OPTS,
        });
        if (!res.ok) {
          console.error(`Discord ${hint} revocation failed: HTTP ${res.status}`);
        }
      };
      const tasks: Promise<void>[] = [revokeOne(accessToken, "access_token")];
      if (refreshToken) {
        tasks.push(revokeOne(refreshToken, "refresh_token"));
      }
      await Promise.all(tasks);
      break;
    }
  }
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

  const json = await res.json().catch(() => {
    throw new Error("Discord /users/@me returned non-JSON response");
  });
  const result = discordUserSchema.safeParse(json);
  if (!result.success) {
    console.error("Discord /users/@me response validation failed:", result.error.message);
    throw new Error("Unexpected Discord /users/@me response format");
  }
  const user = result.data;

  return {
    providerUserId: user.id,
    providerUsername: user.global_name || user.username,
    providerEmail: user.verified === true ? user.email : null,
    emailVerified: user.verified === true && user.email !== null,
    accessToken,
    refreshToken,
    tokenExpiresAt,
  };
}
