/**
 * OAuth provider configurations, token exchange, and user info fetching.
 */
import * as jose from "jose";
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

export function buildAuthorizeUrl(
  provider: OAuthProvider,
  env: Env,
  redirectUri: string,
  codeChallenge: string,
  state: string,
  nonce?: string,
): string {
  switch (provider) {
    case "github": {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      url.searchParams.set("redirect_uri", redirectUri);
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

// ─── Token Exchange ──────────────────────────────────────

interface TokenResponse {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
}

export async function exchangeCode(
  provider: OAuthProvider,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  env: Env,
): Promise<TokenResponse> {
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
  });

  const data = (await res.json()) as TokenResponse & { error?: string; error_description?: string };

  // GitHub returns 200 even on errors
  if (data.error) {
    throw new Error(`OAuth token exchange failed: ${data.error} - ${data.error_description ?? ""}`);
  }

  if (!res.ok) {
    throw new Error(`OAuth token exchange failed: HTTP ${res.status}`);
  }

  return data;
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
    case "google":
      return validateGoogleIdToken(
        tokenResponse.id_token!,
        tokenResponse.access_token,
        tokenResponse.refresh_token ?? null,
        expiresAt,
        env,
        kv,
        nonce,
      );
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
    "User-Agent": "CloudTime/1.0",
  };

  const [userRes, emailsRes] = await Promise.all([
    fetch("https://api.github.com/user", { headers }),
    fetch("https://api.github.com/user/emails", { headers }),
  ]);

  if (!userRes.ok) throw new Error(`GitHub /user failed: ${userRes.status}`);
  if (!emailsRes.ok) throw new Error(`GitHub /user/emails failed: ${emailsRes.status}`);

  const user = (await userRes.json()) as { id: number; login: string };
  const emails = (await emailsRes.json()) as Array<{
    email: string;
    primary: boolean;
    verified: boolean;
  }>;

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

let cachedJWKS: jose.JWTVerifyGetKey | null = null;
let jwksCachedAt = 0;
const JWKS_MEMORY_TTL = 60_000; // 1 min in-memory, KV has 10min TTL

async function getGoogleJWKS(kv: KVNamespace): Promise<jose.JWTVerifyGetKey> {
  // In-memory cache for hot path
  if (cachedJWKS && Date.now() - jwksCachedAt < JWKS_MEMORY_TTL) {
    return cachedJWKS;
  }

  // Try KV cache
  const kvKey = "google:jwks";
  const cached = await kv.get(kvKey);
  if (cached) {
    const jwks = JSON.parse(cached) as jose.JSONWebKeySet;
    cachedJWKS = jose.createLocalJWKSet(jwks);
    jwksCachedAt = Date.now();
    return cachedJWKS;
  }

  // Fetch from Google
  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!res.ok) throw new Error(`Failed to fetch Google JWKS: ${res.status}`);
  const jwks = (await res.json()) as jose.JSONWebKeySet;

  // Cache in KV (10 min TTL)
  await kv.put(kvKey, JSON.stringify(jwks), { expirationTtl: 600 });
  cachedJWKS = jose.createLocalJWKSet(jwks);
  jwksCachedAt = Date.now();
  return cachedJWKS;
}

async function validateGoogleIdToken(
  idToken: string,
  accessToken: string,
  refreshToken: string | null,
  tokenExpiresAt: string | null,
  env: Env,
  kv: KVNamespace,
  nonce?: string,
): Promise<ProviderUserInfo> {
  const jwks = await getGoogleJWKS(kv);

  const { payload } = await jose.jwtVerify(idToken, jwks, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: env.GOOGLE_CLIENT_ID,
  });

  // Validate azp (authorized party) — prevents cross-client token reuse
  if (payload.azp && payload.azp !== env.GOOGLE_CLIENT_ID) {
    throw new Error("Google id_token azp mismatch");
  }

  // Validate nonce
  if (nonce && payload.nonce !== nonce) {
    throw new Error("Google id_token nonce mismatch");
  }

  // Validate at_hash (access token hash) if present
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

  return {
    providerUserId: payload.sub!,
    providerUsername: (payload.name as string) ?? (payload.email as string) ?? payload.sub!,
    providerEmail: (payload.email as string) ?? null,
    emailVerified: payload.email_verified === true,
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
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) throw new Error(`Discord /users/@me failed: ${res.status}`);

  const user = (await res.json()) as {
    id: string;
    username: string;
    global_name: string | null;
    email: string | null;
    verified: boolean;
  };

  return {
    providerUserId: user.id,
    providerUsername: user.global_name ?? user.username,
    providerEmail: user.verified ? user.email : null,
    emailVerified: user.verified && user.email !== null,
    accessToken,
    refreshToken,
    tokenExpiresAt,
  };
}
