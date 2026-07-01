/**
 * Regression tests for Issue #163: the wildcard session middleware in the
 * sessions sub-app must not intercept the public login routes mounted after
 * it (GET /auth/:provider and GET /auth/:provider/callback). Anonymous
 * clients must be able to start an OAuth login; the session-scoped routes
 * must remain protected.
 */
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { seedUserWithSession, truncate } from "../helpers/fixtures";

const BASE = "https://test.cloudtime.dev";
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(async () => {
  await truncate("sessions", "oauth_accounts", "users");
});

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("auth route mounting (#163)", () => {
  it("anonymous OAuth initiate redirects to the provider (no middleware 401)", async () => {
    const res = await call("/api/v1/auth/github");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("Location") ?? "");
    expect(location.origin).toBe("https://github.com");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(res.headers.get("Set-Cookie")).toContain("__Host-oauth_state=");
  });

  it("anonymous callback reaches handler-level validation (400, not 401)", async () => {
    const res = await call("/api/v1/auth/github/callback");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing state or code" });
  });

  it("invalid provider still yields the handler's 400", async () => {
    const res = await call("/api/v1/auth/nope");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid provider" });
  });

  it("session-scoped routes remain protected for anonymous clients", async () => {
    for (const path of ["/api/v1/auth/session", "/api/v1/auth/sessions", "/api/v1/auth/providers"]) {
      const res = await call(path);
      expect(res.status, path).toBe(401);
    }
    const apiKey = await call("/api/v1/auth/api-key", {
      method: "POST",
      headers: { Origin: BASE },
    });
    expect(apiKey.status).toBe(401);
  });

  it("session-scoped routes still work with a valid session", async () => {
    const user = await seedUserWithSession({ username: "owner" });
    const res = await call("/api/v1/auth/session", {
      headers: { Cookie: `__Host-session=${user.sessionToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { user: { id: string } } };
    expect(body.data.user.id).toBe(user.userId);
  });

  it("regenerates a UUID API key that authenticates", async () => {
    const user = await seedUserWithSession({ username: "owner" });
    const res = await call("/api/v1/auth/api-key", {
      method: "POST",
      headers: {
        Cookie: `__Host-session=${user.sessionToken}`,
        Origin: BASE,
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { api_key: string } };
    expect(body.data.api_key).toMatch(UUID_V4_RE);

    const authenticated = await call("/api/v1/users/current", {
      headers: { Authorization: `Bearer ${body.data.api_key}` },
    });
    expect(authenticated.status).toBe(200);
  });
});
