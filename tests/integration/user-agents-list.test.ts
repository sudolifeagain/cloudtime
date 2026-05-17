/**
 * Integration tests for GET /api/v1/users/current/user_agents (Issue #105).
 * The table is populated by heartbeat ingestion (Issue #99); these tests seed
 * rows directly so the endpoint can be exercised without the full POST path.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { seedUser, truncate, type SeededUser } from "../helpers/fixtures";

let user: SeededUser;

beforeEach(async () => {
  user = await seedUser({ username: "alice" });
});

afterEach(async () => {
  await truncate("user_agents", "users");
  await env.KV.delete(`apikey:${user.apiKeyHash}`);
});

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://test.cloudtime.dev${path}`, init),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

function auth(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

async function seedUserAgent(opts: {
  userId: string;
  value: string;
  editor?: string;
  version?: string;
  os?: string;
  lastSeenAt?: string;
  createdAt?: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO user_agents (id, user_id, value, editor, version, os, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))`,
  )
    .bind(
      id,
      opts.userId,
      opts.value,
      opts.editor ?? null,
      opts.version ?? null,
      opts.os ?? null,
      opts.lastSeenAt ?? null,
      opts.createdAt ?? null,
    )
    .run();
  return id;
}

describe("GET /api/v1/users/current/user_agents", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await call("/api/v1/users/current/user_agents");
    expect(res.status).toBe(401);
  });

  it("returns {data: []} when no rows exist", async () => {
    const res = await call("/api/v1/users/current/user_agents", {
      headers: auth(user.apiKey),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it("returns user_agents ordered by last_seen_at DESC, isolated to the caller", async () => {
    // Seed three for our user with different last_seen_at, plus one for a
    // different user that must not appear in the response.
    await seedUserAgent({
      userId: user.userId,
      value: "plugin-client/v1 (linux-1-amd64) runtime editor-a/1.0.0",
      editor: "editor-a",
      version: "1.0.0",
      os: "linux",
      lastSeenAt: "2026-05-01 10:00:00",
      createdAt: "2026-04-01 10:00:00",
    });
    await seedUserAgent({
      userId: user.userId,
      value: "plugin-client/v1 (darwin-1-arm64) runtime editor-b/14.0.3",
      editor: "editor-b",
      version: "14.0.3",
      os: "darwin",
      lastSeenAt: "2026-05-17 12:00:00",
      createdAt: "2026-04-17 12:00:00",
    });
    await seedUserAgent({
      userId: user.userId,
      value: "plugin-client/v1 (windows-10-amd64) runtime editor-c/9.0.0",
      editor: "editor-c",
      version: "9.0.0",
      os: "windows",
      lastSeenAt: "2026-05-10 08:00:00",
      createdAt: "2026-04-10 08:00:00",
    });

    const other = await seedUser({ username: "bob" });
    await seedUserAgent({
      userId: other.userId,
      value: "plugin-client/v1 (linux-1-amd64) runtime editor-d/1.0.0",
    });

    const res = await call("/api/v1/users/current/user_agents", {
      headers: auth(user.apiKey),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        editor?: string;
        os?: string;
        value: string;
        last_seen_at: string;
        created_at: string;
      }>;
    };
    expect(body.data.map((ua) => ua.editor)).toEqual([
      "editor-b",
      "editor-c",
      "editor-a",
    ]);
    expect(body.data[0].last_seen_at).toBe("2026-05-17T12:00:00Z");
    expect(body.data[0].created_at).toBe("2026-04-17T12:00:00Z");
    // No leak from the other user.
    expect(body.data.some((ua) => ua.value.includes("editor-d"))).toBe(false);

    await env.KV.delete(`apikey:${other.apiKeyHash}`);
  });

  it("converts INTEGER 0/1 boolean columns to proper booleans in the response", async () => {
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO user_agents (id, user_id, value, is_browser_extension, is_desktop_app)
       VALUES (?, ?, ?, 1, 0)`,
    )
      .bind(id, user.userId, "plugin-client/v1 (linux-1-amd64) runtime web/1.0")
      .run();

    const res = await call("/api/v1/users/current/user_agents", {
      headers: auth(user.apiKey),
    });
    const body = (await res.json()) as {
      data: Array<{ is_browser_extension: unknown; is_desktop_app: unknown }>;
    };
    expect(body.data[0].is_browser_extension).toBe(true);
    expect(body.data[0].is_desktop_app).toBe(false);
  });
});
