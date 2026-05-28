/**
 * Integration tests for Custom Rules (specs/101-custom-rules-crud/):
 * CRUD endpoints plus the heartbeat-ingestion remap (change / hide).
 * Runs against the in-memory D1 + KV provided by vitest-pool-workers.
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
const RULES = "/api/v1/users/current/custom_rules";
const HEARTBEATS = "/api/v1/users/current/heartbeats";

let user: SeededUser;

beforeEach(async () => {
  user = await seedUser({ username: "alice", email: "alice@example.test", timezone: "UTC" });
});

afterEach(async () => {
  await truncate("heartbeats", "user_projects", "custom_rules", "users");
  await env.KV.delete(`apikey:${user.apiKeyHash}`);
  await env.KV.delete(`customrules:${user.userId}`);
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

interface RuleShape {
  id: string;
  action: string;
  source: string;
  operation: string;
  source_value: string;
  destination: string;
  destination_value: string;
  priority: number;
  created_at: string;
}

function putRules(apiKey: string, rules: unknown[]): Promise<Response> {
  return call(RULES, { method: "PUT", headers: authJson(apiKey), body: JSON.stringify(rules) });
}

const changeOldToNew = {
  action: "change",
  source: "project",
  operation: "equals",
  source_value: "cloudtime-old",
  destination: "project",
  destination_value: "cloudtime",
};
const hideWork = {
  action: "hide",
  source: "project",
  operation: "starts_with",
  source_value: "work/",
};

// --- CRUD --------------------------------------------------------------------

describe("custom_rules CRUD", () => {
  it("GET returns {data:[]} for a user with no rules", async () => {
    const res = await call(RULES, { headers: bearer(user.apiKey) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it("PUT replaces the set and echoes server-assigned id/created_at/priority", async () => {
    const res = await putRules(user.apiKey, [changeOldToNew, hideWork]);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: RuleShape[] };
    expect(data).toHaveLength(2);
    expect(data[0].id).toMatch(/[0-9a-f-]{36}/);
    expect(data[0].priority).toBe(0);
    expect(data[1].priority).toBe(1);
    expect(data[1].action).toBe("hide");
    expect(data[0].created_at).toBeTruthy();

    const list = await call(RULES, { headers: bearer(user.apiKey) });
    const listed = (await list.json()) as { data: RuleShape[] };
    expect(listed.data.map((r) => r.source_value)).toEqual(["cloudtime-old", "work/"]);
  });

  it("orders rules by priority ascending", async () => {
    await putRules(user.apiKey, [
      { ...changeOldToNew, source_value: "p2", priority: 2 },
      { ...changeOldToNew, source_value: "p0", priority: 0 },
      { ...changeOldToNew, source_value: "p1", priority: 1 },
    ]);
    const list = await call(RULES, { headers: bearer(user.apiKey) });
    const { data } = (await list.json()) as { data: RuleShape[] };
    expect(data.map((r) => r.source_value)).toEqual(["p0", "p1", "p2"]);
  });

  it("rejects an invalid rule with 400 and leaves the existing set unchanged", async () => {
    await putRules(user.apiKey, [changeOldToNew]);
    // change rule missing destination_value
    const bad = await putRules(user.apiKey, [
      { action: "change", source: "project", operation: "equals", source_value: "x", destination: "project" },
    ]);
    expect(bad.status).toBe(400);
    const list = await call(RULES, { headers: bearer(user.apiKey) });
    const { data } = (await list.json()) as { data: RuleShape[] };
    expect(data).toHaveLength(1);
    expect(data[0].source_value).toBe("cloudtime-old");
  });

  it("PUT [] clears all rules", async () => {
    await putRules(user.apiKey, [changeOldToNew]);
    const cleared = await putRules(user.apiKey, []);
    expect(cleared.status).toBe(200);
    const list = await call(RULES, { headers: bearer(user.apiKey) });
    expect(await list.json()).toEqual({ data: [] });
  });

  it("DELETE removes an owned rule (204) and 404s on unknown id", async () => {
    await putRules(user.apiKey, [changeOldToNew, hideWork]);
    const list = await call(RULES, { headers: bearer(user.apiKey) });
    const { data } = (await list.json()) as { data: RuleShape[] };
    const id = data[0].id;

    const del = await call(`${RULES}/${id}`, { method: "DELETE", headers: bearer(user.apiKey) });
    expect(del.status).toBe(204);

    const after = await call(RULES, { headers: bearer(user.apiKey) });
    const { data: remaining } = (await after.json()) as { data: RuleShape[] };
    expect(remaining.find((r) => r.id === id)).toBeUndefined();
    expect(remaining).toHaveLength(1);

    const unknown = await call(`${RULES}/missing`, { method: "DELETE", headers: bearer(user.apiKey) });
    expect(unknown.status).toBe(404);
  });

  it("isolates rules across users and 404s cross-user DELETE", async () => {
    const bob = await seedUser({ username: "bob", email: "bob@example.test" });
    await putRules(bob.apiKey, [changeOldToNew]);
    const bobList = await call(RULES, { headers: bearer(bob.apiKey) });
    const bobRuleId = ((await bobList.json()) as { data: RuleShape[] }).data[0].id;

    // alice has no rules and cannot see/delete bob's
    expect(await (await call(RULES, { headers: bearer(user.apiKey) })).json()).toEqual({ data: [] });
    const del = await call(`${RULES}/${bobRuleId}`, { method: "DELETE", headers: bearer(user.apiKey) });
    expect(del.status).toBe(404);

    const stillThere = await call(RULES, { headers: bearer(bob.apiKey) });
    expect(((await stillThere.json()) as { data: RuleShape[] }).data).toHaveLength(1);

    await env.KV.delete(`apikey:${bob.apiKeyHash}`);
    await env.KV.delete(`customrules:${bob.userId}`);
  });

  it("requires authentication", async () => {
    expect((await call(RULES)).status).toBe(401);
    // application/json bypasses the form-style CSRF guard, reaching authMiddleware.
    expect(
      (await call(RULES, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "[]" })).status,
    ).toBe(401);
    expect(
      (await call(`${RULES}/x`, { method: "DELETE", headers: { "Content-Type": "application/json" } })).status,
    ).toBe(401);
  });
});

// --- Heartbeat ingestion remap ----------------------------------------------

describe("custom_rules heartbeat remap", () => {
  const nowEpoch = () => Math.floor(Date.now() / 1000);
  const today = () => new Date().toISOString().slice(0, 10);

  async function listHeartbeats(apiKey: string): Promise<Array<{ id: string; project?: string }>> {
    const res = await call(`${HEARTBEATS}?date=${today()}`, { headers: bearer(apiKey) });
    return ((await res.json()) as { data: Array<{ id: string; project?: string }> }).data;
  }

  it("change rule rewrites the dimension on an ingested heartbeat", async () => {
    await putRules(user.apiKey, [changeOldToNew]);
    const res = await call(HEARTBEATS, {
      method: "POST",
      headers: authJson(user.apiKey),
      body: JSON.stringify({ entity: "/x.ts", type: "file", time: nowEpoch(), project: "cloudtime-old" }),
    });
    expect(res.status).toBe(201);

    const stored = await listHeartbeats(user.apiKey);
    expect(stored).toHaveLength(1);
    expect(stored[0].project).toBe("cloudtime");
  });

  it("hide rule drops the heartbeat while the request still succeeds", async () => {
    await putRules(user.apiKey, [hideWork]);
    const res = await call(HEARTBEATS, {
      method: "POST",
      headers: authJson(user.apiKey),
      body: JSON.stringify({ entity: "/y.ts", type: "file", time: nowEpoch(), project: "work/secret" }),
    });
    expect(res.status).toBe(201); // success, no leak that it was dropped
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBeTruthy();

    const stored = await listHeartbeats(user.apiKey);
    expect(stored).toHaveLength(0); // not persisted
  });

  it("bulk: changes, hides, and keeps in order", async () => {
    await putRules(user.apiKey, [changeOldToNew, hideWork]);
    const res = await call(`${HEARTBEATS}.bulk`, {
      method: "POST",
      headers: authJson(user.apiKey),
      body: JSON.stringify([
        { entity: "/a.ts", type: "file", time: nowEpoch(), project: "cloudtime-old" },
        { entity: "/b.ts", type: "file", time: nowEpoch(), project: "work/secret" },
        { entity: "/c.ts", type: "file", time: nowEpoch(), project: "keep" },
      ]),
    });
    expect(res.status).toBe(202);
    const { responses } = (await res.json()) as { responses: [{ data: { id: string } | null; error: string | null }, number][] };
    expect(responses).toHaveLength(3);
    // All three report success (the hidden one is indistinguishable).
    expect(responses.every(([item, status]) => status === 201 && item.error === null)).toBe(true);

    const stored = await listHeartbeats(user.apiKey);
    const projects = stored.map((h) => h.project).sort();
    expect(projects).toEqual(["cloudtime", "keep"]); // work/secret hidden
  });

  it("no rules: heartbeats are stored unchanged", async () => {
    const res = await call(HEARTBEATS, {
      method: "POST",
      headers: authJson(user.apiKey),
      body: JSON.stringify({ entity: "/z.ts", type: "file", time: nowEpoch(), project: "cloudtime-old" }),
    });
    expect(res.status).toBe(201);
    const stored = await listHeartbeats(user.apiKey);
    expect(stored[0].project).toBe("cloudtime-old");
  });
});
