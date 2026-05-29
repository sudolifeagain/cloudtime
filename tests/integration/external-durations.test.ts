/**
 * Integration tests for the External Durations endpoints
 * (specs/106-external-durations/): create/upsert, bulk all-or-nothing,
 * list-by-day + filters, bulk delete, isolation, auth — plus a check that
 * /stats is unaffected (parallel series).
 */
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { seedUser, truncate, type SeededUser } from "../helpers/fixtures";

const BASE = "https://test.cloudtime.dev";
const EXT = "/api/v1/users/current/external_durations";

let user: SeededUser;

beforeEach(async () => {
  user = await seedUser({ username: "alice", email: "alice@example.test", timezone: "UTC" });
});

afterEach(async () => {
  await truncate("external_durations", "summaries", "users");
  await env.KV.delete(`apikey:${user.apiKeyHash}`);
});

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function authJson(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

function bearer(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

interface ExtShape {
  id: string;
  external_id: string;
  entity: string;
  start_time: number;
  end_time: number;
  project?: string;
}

// 2026-03-15 in UTC
const D = "2026-03-15";
const T0 = Math.floor(Date.UTC(2026, 2, 15, 9, 0, 0) / 1000);

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    external_id: "evt-1",
    entity: "Standup",
    type: "app",
    start_time: T0,
    end_time: T0 + 900,
    ...overrides,
  };
}

describe("POST /external_durations", () => {
  it("creates one and echoes server fields (201)", async () => {
    const res = await call(EXT, { method: "POST", headers: authJson(user.apiKey), body: JSON.stringify(body()) });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: ExtShape };
    expect(data.id).toMatch(/[0-9a-f-]{36}/);
    expect(data.external_id).toBe("evt-1");
    expect(data.end_time).toBe(T0 + 900);
  });

  it("is idempotent on (user_id, external_id) — re-send updates in place", async () => {
    await call(EXT, { method: "POST", headers: authJson(user.apiKey), body: JSON.stringify(body()) });
    await call(EXT, { method: "POST", headers: authJson(user.apiKey), body: JSON.stringify(body({ end_time: T0 + 1800 })) });

    const list = await call(`${EXT}?date=${D}`, { headers: bearer(user.apiKey) });
    const { data } = (await list.json()) as { data: ExtShape[] };
    expect(data).toHaveLength(1);
    expect(data[0].end_time).toBe(T0 + 1800);
  });

  it("rejects invalid bodies with 400", async () => {
    const bad = [
      body({ entity: undefined }),
      body({ type: "meeting" }),
      body({ category: "not-a-category" }),
      body({ start_time: 100, end_time: 50 }),
    ];
    for (const b of bad) {
      const res = await call(EXT, { method: "POST", headers: authJson(user.apiKey), body: JSON.stringify(b) });
      expect(res.status).toBe(400);
    }
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await call(EXT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body()),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /external_durations.bulk", () => {
  it("creates all on success (201)", async () => {
    const res = await call(`${EXT}.bulk`, {
      method: "POST",
      headers: authJson(user.apiKey),
      body: JSON.stringify([body({ external_id: "a" }), body({ external_id: "b" })]),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: ExtShape[] };
    expect(data.map((d) => d.external_id).sort()).toEqual(["a", "b"]);
  });

  it("is all-or-nothing: one invalid element writes nothing (400)", async () => {
    const res = await call(`${EXT}.bulk`, {
      method: "POST",
      headers: authJson(user.apiKey),
      body: JSON.stringify([body({ external_id: "a" }), body({ external_id: "b", type: "bad" })]),
    });
    expect(res.status).toBe(400);
    const list = await call(`${EXT}?date=${D}`, { headers: bearer(user.apiKey) });
    expect(((await list.json()) as { data: ExtShape[] }).data).toEqual([]);
  });

  it("rejects more than 100 items with 400", async () => {
    const many = Array.from({ length: 101 }, (_, i) => body({ external_id: `e${i}` }));
    const res = await call(`${EXT}.bulk`, { method: "POST", headers: authJson(user.apiKey), body: JSON.stringify(many) });
    expect(res.status).toBe(400);
  });
});

describe("GET /external_durations", () => {
  it("returns only the requested day's entries, ascending, with project filter", async () => {
    await call(`${EXT}.bulk`, {
      method: "POST",
      headers: authJson(user.apiKey),
      body: JSON.stringify([
        body({ external_id: "a", start_time: T0 + 200, end_time: T0 + 400, project: "X" }),
        body({ external_id: "b", start_time: T0, end_time: T0 + 100, project: "Y" }),
        // next day
        body({ external_id: "c", start_time: T0 + 86400, end_time: T0 + 86500 }),
      ]),
    });

    const res = await call(`${EXT}?date=${D}`, { headers: bearer(user.apiKey) });
    const { data } = (await res.json()) as { data: ExtShape[] };
    expect(data.map((d) => d.external_id)).toEqual(["b", "a"]); // ascending by start_time, day-scoped

    const filtered = await call(`${EXT}?date=${D}&project=X`, { headers: bearer(user.apiKey) });
    expect(((await filtered.json()) as { data: ExtShape[] }).data.map((d) => d.external_id)).toEqual(["a"]);
  });

  it("400s on missing date, invalid dates, and invalid timezone", async () => {
    expect((await call(EXT, { headers: bearer(user.apiKey) })).status).toBe(400);
    expect((await call(`${EXT}?date=2026-02-31`, { headers: bearer(user.apiKey) })).status).toBe(400);
    expect((await call(`${EXT}?date=${D}&timezone=Not/AZone`, { headers: bearer(user.apiKey) })).status).toBe(400);
  });

  it("isolates results per user", async () => {
    const bob = await seedUser({ username: "bob", email: "bob@example.test" });
    await call(EXT, { method: "POST", headers: authJson(bob.apiKey), body: JSON.stringify(body({ external_id: "bob-evt" })) });

    const res = await call(`${EXT}?date=${D}`, { headers: bearer(user.apiKey) });
    expect(((await res.json()) as { data: ExtShape[] }).data).toEqual([]);

    await env.KV.delete(`apikey:${bob.apiKeyHash}`);
  });

  it("returns 401 when unauthenticated", async () => {
    expect((await call(`${EXT}?date=${D}`)).status).toBe(401);
  });
});

describe("DELETE /external_durations.bulk", () => {
  it("deletes by id within the day (204) and ignores unknown ids", async () => {
    const created = await call(EXT, { method: "POST", headers: authJson(user.apiKey), body: JSON.stringify(body()) });
    const id = ((await created.json()) as { data: ExtShape }).data.id;

    const del = await call(`${EXT}.bulk`, {
      method: "DELETE",
      headers: authJson(user.apiKey),
      body: JSON.stringify({ date: D, ids: [id, "does-not-exist"] }),
    });
    expect(del.status).toBe(204);

    const list = await call(`${EXT}?date=${D}`, { headers: bearer(user.apiKey) });
    expect(((await list.json()) as { data: ExtShape[] }).data).toEqual([]);
  });

  it("400s on a malformed body", async () => {
    const res = await call(`${EXT}.bulk`, {
      method: "DELETE",
      headers: authJson(user.apiKey),
      body: JSON.stringify({ ids: ["x"] }),
    });
    expect(res.status).toBe(400);

    const invalidDate = await call(`${EXT}.bulk`, {
      method: "DELETE",
      headers: authJson(user.apiKey),
      body: JSON.stringify({ date: "2026-02-31", ids: ["x"] }),
    });
    expect(invalidDate.status).toBe(400);
  });
});

describe("parallel series", () => {
  it("does not affect /stats totals", async () => {
    await call(EXT, { method: "POST", headers: authJson(user.apiKey), body: JSON.stringify(body({ end_time: T0 + 100000 })) });
    const stats = await call(`/api/v1/users/current/stats/last_7_days`, { headers: bearer(user.apiKey) });
    const json = (await stats.json()) as { data?: { total_seconds?: number } };
    // No summaries seeded → stats total stays 0 regardless of external durations.
    expect(json.data?.total_seconds ?? 0).toBe(0);
  });
});
