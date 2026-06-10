/**
 * Integration tests for the single-user owner allowlist (Issue #157,
 * specs/157-owner-allowlist/), driving the real GitHub login flow with the
 * provider's HTTP endpoints stubbed.
 *
 * Note on the harness (research D-6): the plan called for the workers-pool
 * `fetchMock`, but @cloudflare/vitest-pool-workers 0.16.x does not export it
 * (the undici MockAgent types in cloudflare-test.d.ts are vestigial). Tests
 * and the imported worker share one isolate here, so outbound provider calls
 * are stubbed by swapping `globalThis.fetch` per test instead — same
 * coverage, strictly failing on any un-stubbed outbound request.
 *
 * Flow per attempt: GET /auth/github captures the state cookie + redirect,
 * then GET /auth/github/callback runs the full handler — token exchange,
 * user-info fetch, email-verified gate, and the allowlist gate — against
 * real in-memory D1/KV.
 */
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { seedUser, truncate } from "../helpers/fixtures";

const BASE = "https://test.cloudtime.dev";
const REGISTRATION_CLOSED = {
  error: "Registration closed. This instance only allows one user.",
};

// ─── Outbound fetch stub ─────────────────────────────────

interface StubRoute {
  method: string;
  url: string; // "<origin><pathname>"
  body: unknown;
  hits: number;
}

const originalFetch = globalThis.fetch;
let routes: StubRoute[] = [];

function stubRoute(method: string, url: string, body: unknown): void {
  routes.push({ method, url, body, hits: 0 });
}

beforeEach(() => {
  routes = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    const key = `${req.method} ${u.origin}${u.pathname}`;
    // Prefer a not-yet-consumed registration so a flow stubbed twice in one
    // test (e.g. two login attempts) serves each registration once.
    const route =
      routes.find((r) => `${r.method} ${r.url}` === key && r.hits === 0) ??
      routes.find((r) => `${r.method} ${r.url}` === key);
    if (!route) {
      throw new Error(`Unexpected outbound fetch in test: ${key}`);
    }
    route.hits++;
    return new Response(JSON.stringify(route.body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  // Truncate before asserting so a failed assertion cannot leak DB state
  // into the next test.
  await truncate("sessions", "oauth_accounts", "users");
  for (const r of routes) {
    expect(r.hits, `stubbed route never hit: ${r.method} ${r.url}`).toBeGreaterThan(0);
  }
});

// ─── Flow helpers ────────────────────────────────────────

async function call(
  path: string,
  init: RequestInit = {},
  envOverrides: Partial<Cloudflare.Env> = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const testEnv = { ...env, ...envOverrides };
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Start a GitHub login and capture the state param + double-submit cookie. */
async function startLogin(
  envOverrides: Partial<Cloudflare.Env> = {},
): Promise<{ state: string; cookie: string }> {
  const res = await call("/api/v1/auth/github", {}, envOverrides);
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("Location") ?? "");
  const state = location.searchParams.get("state");
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  const match = setCookie.match(/__Host-oauth_state=([^;]+)/);
  expect(state).toBeTruthy();
  expect(match).toBeTruthy();
  return { state: state as string, cookie: `__Host-oauth_state=${match![1]}` };
}

/** Stub the three GitHub endpoints one callback invocation hits. */
function mockGitHub(opts: { id: number; login: string; email: string }): void {
  stubRoute("POST", "https://github.com/login/oauth/access_token", {
    access_token: "test-access-token",
    token_type: "bearer",
    scope: "read:user,user:email",
  });
  stubRoute("GET", "https://api.github.com/user", { id: opts.id, login: opts.login });
  stubRoute("GET", "https://api.github.com/user/emails", [
    { email: opts.email, primary: true, verified: true },
  ]);
}

async function completeLogin(
  ghUser: { id: number; login: string; email: string },
  envOverrides: Partial<Cloudflare.Env> = {},
): Promise<Response> {
  const { state, cookie } = await startLogin(envOverrides);
  mockGitHub(ghUser);
  return call(
    `/api/v1/auth/github/callback?code=test-code&state=${state}`,
    { headers: { Cookie: cookie } },
    envOverrides,
  );
}

async function userCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
  return row?.n ?? 0;
}

// ─── Cases ───────────────────────────────────────────────

describe("single-user owner allowlist (#157)", () => {
  const ALLOW = { ALLOWED_OWNER_EMAIL: "owner@example.test" };

  it("allowed verified email bootstraps the owner (US1)", async () => {
    const res = await completeLogin(
      { id: 1001, login: "owner", email: "owner@example.test" },
      ALLOW,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { is_new_user: boolean } };
    expect(body.data.is_new_user).toBe(true);
    expect(await userCount()).toBe(1);
  });

  it("matches case-insensitively with surrounding whitespace (US1 scenario 4)", async () => {
    const res = await completeLogin(
      { id: 1002, login: "owner", email: "Owner@Example.TEST" },
      { ALLOWED_OWNER_EMAIL: " owner@example.test " },
    );
    expect(res.status).toBe(200);
    expect(await userCount()).toBe(1);
  });

  it("mismatched email gets the registration-closed 403 and writes nothing (US1)", async () => {
    const res = await completeLogin(
      { id: 2001, login: "intruder", email: "intruder@example.test" },
      ALLOW,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(REGISTRATION_CLOSED);
    expect(await userCount()).toBe(0);
  });

  it("rejection is byte-identical to the post-bootstrap registration-closed response (US3)", async () => {
    // Allowlist rejection on an empty instance...
    const rejected = await completeLogin(
      { id: 2002, login: "intruder", email: "intruder@example.test" },
      ALLOW,
    );
    expect(rejected.status).toBe(403);
    const allowlistBody = await rejected.text();

    // ...versus today's registration-closed rejection (owner exists, no allowlist).
    await seedUser({ username: "owner" });
    const closed = await completeLogin({
      id: 2003,
      login: "stranger",
      email: "stranger@example.test",
    });
    expect(closed.status).toBe(403);
    expect(await closed.text()).toBe(allowlistBody);
  });

  it("variable unset: any verified identity bootstraps exactly as today (US2/FR-001)", async () => {
    const res = await completeLogin({
      id: 3001,
      login: "anyone",
      email: "anyone@example.test",
    });
    expect(res.status).toBe(200);
    expect(await userCount()).toBe(1);
  });

  it("owner already exists: a stranger gets the same 403 whether or not the allowlist is set (US2 scenario 3)", async () => {
    await seedUser({ username: "owner", email: "owner@example.test" });
    const res = await completeLogin(
      { id: 4001, login: "stranger", email: "owner@example.test" },
      ALLOW,
    );
    // Email matches the allowlist, but the instance is already claimed —
    // the existing only-if-no-users guard answers, unchanged.
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(REGISTRATION_CLOSED);
    expect(await userCount()).toBe(1);
  });
});
