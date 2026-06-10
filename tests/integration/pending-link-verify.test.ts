/**
 * Integration tests for the out-of-band PendingLink verification flow
 * (Issue #80). Seeds PendingLink rows directly to exercise the verify
 * endpoint and the approve-gate without spinning up the full OAuth flow.
 */
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import {
  generateSessionToken,
  generateVerificationToken,
  sha256Hex,
} from "../../src/utils/crypto";
import { seedUser, truncate, type SeededUser } from "../helpers/fixtures";

const BASE = "https://test.cloudtime.dev";

let owner: SeededUser;
let sessionToken: string;

beforeEach(async () => {
  owner = await seedUser({ username: "alice", email: "alice@example.test" });
  // Owner has an active session for the approve calls
  sessionToken = generateSessionToken();
  const sessionTokenHash = await sha256Hex(sessionToken);
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_active_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now', '+7 days'), datetime('now'))`,
  )
    .bind(crypto.randomUUID(), owner.userId, sessionTokenHash)
    .run();
});

afterEach(async () => {
  await truncate("pending_links", "sessions", "oauth_accounts", "users");
  await env.KV.delete(`apikey:${owner.apiKeyHash}`);
});

async function call(
  path: string,
  init: RequestInit = {},
  envOverrides: Partial<Cloudflare.Env> = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const testEnv = { ...env, INSTANCE_MODE: "multi", ...envOverrides };
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

interface SeededPendingLink {
  pendingLinkId: string;
  token: string;
  tokenHash: string;
}

async function seedPendingLink(opts: {
  ownerId: string;
  expiresInSeconds?: number;
  alreadyVerified?: boolean;
}): Promise<SeededPendingLink> {
  const { plaintext: token, hash: tokenHash } = await generateVerificationToken();
  const pendingLinkId = crypto.randomUUID();
  const ttl = opts.expiresInSeconds ?? 3600;
  await env.DB.prepare(
    `INSERT INTO pending_links (
       id, existing_user_id, provider, provider_user_id, provider_username,
       provider_email, email_verified,
       expires_at,
       email_verification_token_hash, email_verified_at
     ) VALUES (?, ?, 'google', 'google-uid-1', 'alice', 'alice@example.test', 1,
       datetime('now', '+' || ? || ' seconds'), ?, ?)`,
  )
    .bind(
      pendingLinkId,
      opts.ownerId,
      ttl,
      tokenHash,
      opts.alreadyVerified ? new Date().toISOString().replace("T", " ").replace("Z", "") : null,
    )
    .run();
  return { pendingLinkId, token, tokenHash };
}

describe("GET /api/v1/auth/link/verify/:token", () => {
  it("consumes the token, sets email_verified_at, and returns 200 HTML", async () => {
    const { pendingLinkId, token } = await seedPendingLink({ ownerId: owner.userId });

    const res = await call(`/api/v1/auth/link/verify/${token}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Email verified");

    const row = await env.DB.prepare(
      "SELECT email_verified_at FROM pending_links WHERE id = ?",
    )
      .bind(pendingLinkId)
      .first<{ email_verified_at: string | null }>();
    expect(row?.email_verified_at).not.toBeNull();
  });

  it("returns 410 'Token already used' on replay", async () => {
    const { token } = await seedPendingLink({ ownerId: owner.userId });
    const first = await call(`/api/v1/auth/link/verify/${token}`);
    expect(first.status).toBe(200);

    const second = await call(`/api/v1/auth/link/verify/${token}`);
    expect(second.status).toBe(410);
    expect(await second.json()).toEqual({ error: "Token already used" });
  });

  it("returns 410 'Token not found' for an unknown token", async () => {
    const res = await call(`/api/v1/auth/link/verify/no-such-token`);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "Token not found" });
  });

  it("returns 410 'Token not found' for malformed tokens (format pre-check)", async () => {
    // Real tokens are exactly 43 url-safe base64 chars (Issue #152). A wrong
    // length or an out-of-alphabet character must produce the same response
    // as an unknown token so the pre-check is not distinguishable.
    const wrongLength = "A".repeat(42);
    const badCharset = "x".repeat(42) + "!";

    for (const bad of [wrongLength, badCharset]) {
      const res = await call(`/api/v1/auth/link/verify/${bad}`);
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual({ error: "Token not found" });
    }
  });

  it("returns 410 'Token expired' when the underlying row has expired", async () => {
    const { token, pendingLinkId } = await seedPendingLink({ ownerId: owner.userId });
    // Force expiry by editing the row.
    await env.DB.prepare(
      "UPDATE pending_links SET expires_at = datetime('now', '-1 minute') WHERE id = ?",
    )
      .bind(pendingLinkId)
      .run();

    const res = await call(`/api/v1/auth/link/verify/${token}`);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "Token expired" });
  });

  it("returns 405 for non-GET methods (CSRF bypass for the verify path)", async () => {
    const res = await call("/api/v1/auth/link/verify/anything", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });

  it("returns 405 for HEAD without consuming the token", async () => {
    const { pendingLinkId, token } = await seedPendingLink({ ownerId: owner.userId });

    const res = await call(`/api/v1/auth/link/verify/${token}`, { method: "HEAD" });

    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    const row = await env.DB.prepare(
      "SELECT email_verified_at FROM pending_links WHERE id = ?",
    )
      .bind(pendingLinkId)
      .first<{ email_verified_at: string | null }>();
    expect(row?.email_verified_at).toBeNull();
  });

  it("always returns 410 in single-user mode", async () => {
    const { pendingLinkId, token } = await seedPendingLink({ ownerId: owner.userId });

    const res = await call(
      `/api/v1/auth/link/verify/${token}`,
      {},
      { INSTANCE_MODE: "single" },
    );

    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "Token not found" });
    const row = await env.DB.prepare(
      "SELECT email_verified_at FROM pending_links WHERE id = ?",
    )
      .bind(pendingLinkId)
      .first<{ email_verified_at: string | null }>();
    expect(row?.email_verified_at).toBeNull();
  });
});

describe("POST /api/v1/auth/link/approve/:pending_link_id email-verification gate", () => {
  it("returns 403 'Email verification required' before the verify link is clicked", async () => {
    const { pendingLinkId } = await seedPendingLink({ ownerId: owner.userId });

    const res = await call(`/api/v1/auth/link/approve/${pendingLinkId}`, {
      method: "POST",
      headers: {
        Cookie: `__Host-session=${sessionToken}`,
        Origin: BASE,
        "Content-Type": "application/json",
      },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Email verification required" });

    // Row remains in place; merge did not happen.
    const linkCount = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM oauth_accounts WHERE user_id = ?",
    )
      .bind(owner.userId)
      .first<{ c: number }>();
    expect(linkCount?.c).toBe(0);
  });

  it("returns 200 and completes the merge after the verify link is consumed", async () => {
    const { pendingLinkId, token } = await seedPendingLink({ ownerId: owner.userId });

    // Step 1: verify
    const verifyRes = await call(`/api/v1/auth/link/verify/${token}`);
    expect(verifyRes.status).toBe(200);

    // Step 2: approve
    const approveRes = await call(`/api/v1/auth/link/approve/${pendingLinkId}`, {
      method: "POST",
      headers: {
        Cookie: `__Host-session=${sessionToken}`,
        Origin: BASE,
        "Content-Type": "application/json",
      },
    });

    expect(approveRes.status).toBe(200);
    const body = (await approveRes.json()) as { data: { user: { id: string } } };
    expect(body.data.user.id).toBe(owner.userId);

    // oauth_accounts row exists, pending_links row consumed.
    const oauthRow = await env.DB.prepare(
      "SELECT user_id FROM oauth_accounts WHERE provider = 'google' AND provider_user_id = 'google-uid-1'",
    ).first<{ user_id: string }>();
    expect(oauthRow?.user_id).toBe(owner.userId);

    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM pending_links WHERE id = ?",
    )
      .bind(pendingLinkId)
      .first<{ c: number }>();
    expect(remaining?.c).toBe(0);
  });

  it("returns 403 for legacy rows lacking a verification token hash", async () => {
    // Insert a pre-feature-shaped row: no token hash, no verified_at.
    const pendingLinkId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO pending_links (
         id, existing_user_id, provider, provider_user_id, provider_username,
         provider_email, email_verified, expires_at
       ) VALUES (?, ?, 'google', 'legacy-uid', 'alice', 'alice@example.test', 1,
         datetime('now', '+1 hour'))`,
    )
      .bind(pendingLinkId, owner.userId)
      .run();

    const res = await call(`/api/v1/auth/link/approve/${pendingLinkId}`, {
      method: "POST",
      headers: {
        Cookie: `__Host-session=${sessionToken}`,
        Origin: BASE,
        "Content-Type": "application/json",
      },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Email verification required" });
  });
});

describe("rate limiting on GET /api/v1/auth/link/verify/:token (#159)", () => {
  const EXCEEDED = {
    RATE_LIMIT_LINK_VERIFY: { limit: async () => ({ success: false }) },
  };

  it("returns 429 with Retry-After and does not consume the token (US1)", async () => {
    const { pendingLinkId, token } = await seedPendingLink({ ownerId: owner.userId });

    const res = await call(`/api/v1/auth/link/verify/${token}`, {}, EXCEEDED);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.json()).toEqual({ error: "Too many requests" });
    const row = await env.DB.prepare(
      "SELECT email_verified_at FROM pending_links WHERE id = ?",
    )
      .bind(pendingLinkId)
      .first<{ email_verified_at: string | null }>();
    expect(row?.email_verified_at).toBeNull();
  });

  it("non-GET probes still get 405 without consuming limiter budget (research D-2)", async () => {
    let calls = 0;
    const spy = {
      RATE_LIMIT_LINK_VERIFY: {
        limit: async () => {
          calls++;
          return { success: false };
        },
      },
    };

    const res = await call("/api/v1/auth/link/verify/anything", { method: "POST" }, spy);

    expect(res.status).toBe(405);
    expect(calls).toBe(0);
  });

  it("passes through unchanged when the limiter allows (US2)", async () => {
    const { token } = await seedPendingLink({ ownerId: owner.userId });
    const ok = {
      RATE_LIMIT_LINK_VERIFY: { limit: async () => ({ success: true }) },
    };

    const res = await call(`/api/v1/auth/link/verify/${token}`, {}, ok);

    expect(res.status).toBe(200);
  });
});
