import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { seedUserWithSession, truncate } from "../helpers/fixtures";

const BASE = "https://test.cloudtime.dev";
const UUID_V4_RE = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await truncate(
    "summaries",
    "heartbeats",
    "user_projects",
    "machine_names",
    "user_agents",
    "sessions",
    "oauth_accounts",
    "users",
  );
  const keys = await env.KV.list();
  await Promise.all(keys.keys.map((key) => env.KV.delete(key.name)));
});

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("web UI", () => {
  it("redirects the root path to the app", async () => {
    const res = await call("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/app");
  });

  it("returns UI-started OAuth callbacks to the app", async () => {
    const hits = stubGitHub();
    const start = await call("/app/login/github");
    expect(start.status).toBe(302);

    const location = new URL(start.headers.get("Location") ?? "");
    const state = location.searchParams.get("state");
    const setCookie = start.headers.get("Set-Cookie") ?? "";
    const stateCookie = setCookie.match(/__Host-oauth_state=([^;]+)/)?.[1];
    expect(location.origin).toBe("https://github.com");
    expect(state).toBeTruthy();
    expect(stateCookie).toBeTruthy();

    const callback = await call(`/api/v1/auth/github/callback?code=test-code&state=${state}`, {
      headers: { Cookie: `__Host-oauth_state=${stateCookie}` },
    });

    expect(callback.status).toBe(303);
    expect(callback.headers.get("Location")).toBe("/app");
    expect(callback.headers.get("Set-Cookie")).toContain("__Host-session=");
    expect(hits()).toBe(3);
  });

  it("renders a login screen for anonymous visitors", async () => {
    const res = await call("/app");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Content-Security-Policy")).toContain("style-src 'self'");

    const html = await res.text();
    expect(html).toContain("CloudTime");
    expect(html).toContain("Continue with GitHub");
  });

  it("renders dashboard data for a session-authenticated user", async () => {
    const user = await seedUserWithSession({ username: "owner", timezone: "Asia/Tokyo" });
    await seedDashboardRows(user.userId);

    const res = await call("/app", {
      headers: { Cookie: `__Host-session=${user.sessionToken}` },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("owner");
    expect(html).toContain("API key");
    expect(html).toContain("cloudtime");
    expect(html).toContain("README.md");
    expect(html).toContain("AI coding");
  });

  it("regenerates an API key from the dashboard form", async () => {
    const user = await seedUserWithSession({ username: "owner" });

    const res = await call("/app/api-key", {
      method: "POST",
      headers: {
        Cookie: `__Host-session=${user.sessionToken}`,
        Origin: BASE,
      },
    });

    expect(res.status).toBe(200);
    const html = await res.text();
    const match = html.match(UUID_V4_RE);
    expect(match?.[0]).toBeTruthy();

    const authenticated = await call("/api/v1/users/current", {
      headers: { Authorization: `Bearer ${match![0]}` },
    });
    expect(authenticated.status).toBe(200);
  });
});

async function seedDashboardRows(userId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now * 1000));

  await env.DB.prepare(
    `INSERT INTO summaries (user_id, date, project, language, editor, category, total_seconds)
     VALUES (?, ?, 'cloudtime', 'TypeScript', 'Codex', 'coding', 3600)`,
  )
    .bind(userId, today)
    .run();

  await env.DB.prepare(
    `INSERT INTO heartbeats (id, user_id, entity, type, time, category, project, language, editor, machine, is_write, created_at)
     VALUES (?, ?, 'README.md', 'file', ?, 'ai coding', 'cloudtime', 'Markdown', 'Codex', 'test-machine', 1, datetime('now'))`,
  )
    .bind(crypto.randomUUID(), userId, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO user_projects (user_id, project, first_heartbeat_at, last_heartbeat_at)
     VALUES (?, 'cloudtime', ?, ?)`,
  )
    .bind(userId, now, now)
    .run();

  await env.DB.prepare(
    `INSERT INTO oauth_accounts (id, user_id, provider, provider_user_id, provider_username, provider_email, email_verified)
     VALUES (?, ?, 'github', '123', 'owner', 'owner@example.test', 1)`,
  )
    .bind(crypto.randomUUID(), userId)
    .run();
}

function stubGitHub(): () => number {
  let hits = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    hits++;

    if (req.method === "POST" && url.origin === "https://github.com" && url.pathname === "/login/oauth/access_token") {
      return json({ access_token: "test-access-token", token_type: "bearer", scope: "read:user,user:email" });
    }

    if (req.method === "GET" && url.origin === "https://api.github.com" && url.pathname === "/user") {
      return json({ id: 12345, login: "owner" });
    }

    if (req.method === "GET" && url.origin === "https://api.github.com" && url.pathname === "/user/emails") {
      return json([{ email: "owner@example.test", primary: true, verified: true }]);
    }

    throw new Error(`Unexpected outbound fetch in test: ${req.method} ${url.origin}${url.pathname}`);
  }) as typeof fetch;

  return () => hits;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
