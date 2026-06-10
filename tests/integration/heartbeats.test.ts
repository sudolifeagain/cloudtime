/**
 * Integration tests for POST /api/v1/users/current/heartbeats and the bulk
 * variant. Uses a real in-memory D1 (vitest-pool-workers) and exercises the
 * authMiddleware via API key bearer authentication.
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
  await truncate("heartbeats", "user_projects", "users");
  // KV cache from the auth middleware would otherwise outlive the user row.
  await env.KV.delete(`apikey:${user.apiKeyHash}`);
});

async function callWorker(path: string, init: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const req = new Request(`https://test.cloudtime.dev${path}`, init);
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function authHeader(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

const TIME_2026_03_14_10_00_UTC = Date.UTC(2026, 2, 14, 10, 0, 0) / 1000;

describe("POST /api/v1/users/current/heartbeats — single", () => {
  it("rejects requests without authentication with 401", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity: "main.ts", type: "file", time: TIME_2026_03_14_10_00_UTC }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects invalid API keys with 401", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeader("ck_definitely_not_a_real_key"),
      },
      body: JSON.stringify({ entity: "main.ts", type: "file", time: TIME_2026_03_14_10_00_UTC }),
    });
    expect(res.status).toBe(401);
  });

  it("creates a heartbeat row with 201 + data envelope on a valid request", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeader(user.apiKey),
      },
      body: JSON.stringify({
        entity: "src/index.ts",
        type: "file",
        time: TIME_2026_03_14_10_00_UTC,
        project: "cloudtime",
        language: "TypeScript",
        is_write: true,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; entity: string } };
    expect(body.data.entity).toBe("src/index.ts");
    expect(body.data.id).toMatch(/^[0-9a-f-]{36}$/i);

    const row = await env.DB.prepare(
      "SELECT user_id, entity, project, language, is_write FROM heartbeats WHERE id = ?",
    )
      .bind(body.data.id)
      .first<{ user_id: string; entity: string; project: string; language: string; is_write: number }>();

    expect(row).toMatchObject({
      user_id: user.userId,
      entity: "src/index.ts",
      project: "cloudtime",
      language: "TypeScript",
      is_write: 1,
    });
  });

  it("returns 400 on malformed JSON", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeader(user.apiKey),
      },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when entity is missing", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeader(user.apiKey),
      },
      body: JSON.stringify({ type: "file", time: TIME_2026_03_14_10_00_UTC }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/v1/users/current/heartbeats.bulk", () => {
  it("inserts multiple heartbeats and returns per-item responses", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats.bulk", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeader(user.apiKey),
      },
      body: JSON.stringify([
        { entity: "a.ts", type: "file", time: TIME_2026_03_14_10_00_UTC },
        { entity: "b.ts", type: "file", time: TIME_2026_03_14_10_00_UTC + 30 },
      ]),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      responses: Array<[{ data: { id: string } | null; error: string | null }, number]>;
    };
    expect(body.responses).toHaveLength(2);
    expect(body.responses[0][1]).toBe(201);
    expect(body.responses[1][1]).toBe(201);
    expect(body.responses[0][0].data?.id).toMatch(/^[0-9a-f-]{36}$/i);

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM heartbeats WHERE user_id = ?",
    )
      .bind(user.userId)
      .first<{ c: number }>();
    expect(count?.c).toBe(2);
  });

  it("returns per-item 400 for invalid heartbeats while still inserting valid ones", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats.bulk", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeader(user.apiKey),
      },
      body: JSON.stringify([
        { entity: "good.ts", type: "file", time: TIME_2026_03_14_10_00_UTC },
        { entity: "", type: "file", time: TIME_2026_03_14_10_00_UTC }, // missing entity
        { entity: "good2.ts", type: "file", time: TIME_2026_03_14_10_00_UTC + 60 },
      ]),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      responses: Array<[{ data: unknown; error: string | null }, number]>;
    };
    expect(body.responses[0][1]).toBe(201);
    expect(body.responses[1][1]).toBe(400);
    expect(body.responses[1][0].error).toBeTruthy();
    expect(body.responses[2][1]).toBe(201);

    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM heartbeats WHERE user_id = ?",
    )
      .bind(user.userId)
      .first<{ c: number }>();
    expect(count?.c).toBe(2);
  });

  it("rejects bulk batches larger than 25 items with 400", async () => {
    const batch = Array.from({ length: 26 }, (_, i) => ({
      entity: `f${i}.ts`,
      type: "file" as const,
      time: TIME_2026_03_14_10_00_UTC + i,
    }));

    const res = await callWorker("/api/v1/users/current/heartbeats.bulk", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeader(user.apiKey),
      },
      body: JSON.stringify(batch),
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty array body with 400", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats.bulk", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeader(user.apiKey),
      },
      body: "[]",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/v1/users/current/heartbeats", () => {
  it("returns the heartbeats inserted by the same API key, isolated per user", async () => {
    // Insert one heartbeat for our user, and one for a second user
    const other = await seedUser({ username: "bob" });

    await env.DB.batch([
      env.DB
        .prepare(
          "INSERT INTO heartbeats (id, user_id, entity, type, time, is_write) VALUES (?, ?, ?, ?, ?, 0)",
        )
        .bind(crypto.randomUUID(), user.userId, "alice.ts", "file", TIME_2026_03_14_10_00_UTC),
      env.DB
        .prepare(
          "INSERT INTO heartbeats (id, user_id, entity, type, time, is_write) VALUES (?, ?, ?, ?, ?, 0)",
        )
        .bind(crypto.randomUUID(), other.userId, "bob.ts", "file", TIME_2026_03_14_10_00_UTC),
    ]);

    const res = await callWorker(
      "/api/v1/users/current/heartbeats?date=2026-03-14",
      { headers: authHeader(user.apiKey) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entity: string }[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].entity).toBe("alice.ts");

    await env.KV.delete(`apikey:${other.apiKeyHash}`);
  });

  it("returns 400 when date query parameter is missing", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats", {
      headers: authHeader(user.apiKey),
    });
    expect(res.status).toBe(400);
  });
});

describe("write-input length caps (#158)", () => {
  afterEach(async () => {
    await truncate("machine_names", "user_agents");
  });

  const base = { type: "file" as const, time: TIME_2026_03_14_10_00_UTC };

  function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return callWorker("/api/v1/users/current/heartbeats", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(user.apiKey), ...headers },
      body: JSON.stringify(body),
    });
  }

  async function heartbeatCount(): Promise<number> {
    const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM heartbeats").first<{ c: number }>();
    return row?.c ?? 0;
  }

  it("rejects an oversized entity with 400 and stores nothing (US1)", async () => {
    const res = await post({ ...base, entity: "x".repeat(4097) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("entity must be at most 4096 characters");
    expect(await heartbeatCount()).toBe(0);
  });

  it("accepts values at exactly the cap — limits are inclusive (FR-003)", async () => {
    const res = await post({
      ...base,
      entity: "x".repeat(4096),
      project: "p".repeat(255),
    });
    expect(res.status).toBe(201);
  });

  it("bulk: an oversized item reports its per-item 400 while valid items persist (US1)", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats.bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(user.apiKey) },
      body: JSON.stringify([
        { ...base, entity: "ok.ts" },
        { ...base, entity: "big.ts", branch: "b".repeat(256) },
      ]),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { responses: [{ data: unknown; error: string | null }, number][] };
    expect(body.responses[0][1]).toBe(201);
    expect(body.responses[1][1]).toBe(400);
    expect(body.responses[1][0].error).toBe("branch must be at most 255 characters");
    expect(await heartbeatCount()).toBe(1);
  });

  it("rejects dependencies beyond the item/count caps (FR-005)", async () => {
    const tooMany = await post({
      ...base,
      entity: "a.ts",
      dependencies: Array.from({ length: 101 }, (_, i) => `dep${i}`),
    });
    expect(tooMany.status).toBe(400);

    const tooLongItem = await post({
      ...base,
      entity: "a.ts",
      dependencies: ["d".repeat(256)],
    });
    expect(tooLongItem.status).toBe(400);
  });

  it("truncates an oversized User-Agent header and accepts the heartbeat (US3)", async () => {
    const res = await post({ ...base, entity: "a.ts" }, { "User-Agent": "u".repeat(600) });
    expect(res.status).toBe(201);
    const row = await env.DB.prepare(
      "SELECT value FROM user_agents WHERE user_id = ?",
    ).bind(user.userId).first<{ value: string }>();
    expect(row?.value).toHaveLength(512);
  });

  it("truncates an oversized X-Machine-Name header and accepts the heartbeat (US3)", async () => {
    const res = await post({ ...base, entity: "a.ts" }, { "X-Machine-Name": "m".repeat(300) });
    expect(res.status).toBe(201);
    const row = await env.DB.prepare(
      "SELECT value FROM machine_names WHERE user_id = ?",
    ).bind(user.userId).first<{ value: string }>();
    expect(row?.value).toHaveLength(255);
  });

  it("rejects oversized body user_agent and machine with 400 (US3 contrast)", async () => {
    const ua = await post({ ...base, entity: "a.ts", user_agent: "u".repeat(513) });
    expect(ua.status).toBe(400);
    const machine = await post({ ...base, entity: "a.ts", machine: "m".repeat(256) });
    expect(machine.status).toBe(400);
  });
});
