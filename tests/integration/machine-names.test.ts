/**
 * Integration tests for the Machine Names feature (specs/104-machine-names/):
 * heartbeat-ingestion population of the machine_names registry plus the
 * read-only list endpoint. Runs against the in-memory D1 + KV.
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
const MACHINES = "/api/v1/users/current/machine_names";
const HEARTBEATS = "/api/v1/users/current/heartbeats";
const RULES = "/api/v1/users/current/custom_rules";

let user: SeededUser;

beforeEach(async () => {
  user = await seedUser({ username: "alice", email: "alice@example.test", timezone: "UTC" });
});

afterEach(async () => {
  await truncate("heartbeats", "user_projects", "machine_names", "custom_rules", "users");
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

interface MachineShape {
  id: string;
  value: string;
  ip?: string;
  last_seen_at: string;
  created_at: string;
}

const nowEpoch = () => Math.floor(Date.now() / 1000);

function postHeartbeat(apiKey: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  return call(HEARTBEATS, { method: "POST", headers: { ...authJson(apiKey), ...headers }, body: JSON.stringify(body) });
}

async function listMachines(apiKey: string): Promise<MachineShape[]> {
  const res = await call(MACHINES, { headers: bearer(apiKey) });
  return ((await res.json()) as { data: MachineShape[] }).data;
}

describe("machine_names ingestion population", () => {
  it("registers a device per distinct machine value", async () => {
    await postHeartbeat(user.apiKey, { entity: "/a.ts", type: "file", time: nowEpoch(), machine: "laptop" });
    await postHeartbeat(user.apiKey, { entity: "/b.ts", type: "file", time: nowEpoch(), machine: "desktop" });

    const machines = await listMachines(user.apiKey);
    expect(machines.map((m) => m.value).sort()).toEqual(["desktop", "laptop"]);
    expect(machines.every((m) => m.id && m.last_seen_at && m.created_at)).toBe(true);
  });

  it("upserts a repeat device without creating a duplicate", async () => {
    await postHeartbeat(user.apiKey, { entity: "/a.ts", type: "file", time: nowEpoch(), machine: "laptop" });
    await postHeartbeat(user.apiKey, { entity: "/c.ts", type: "file", time: nowEpoch(), machine: "laptop" });

    const machines = await listMachines(user.apiKey);
    expect(machines).toHaveLength(1);
    expect(machines[0].value).toBe("laptop");
  });

  it("honours the X-Machine-Name header when the body omits machine", async () => {
    await postHeartbeat(user.apiKey, { entity: "/d.ts", type: "file", time: nowEpoch() }, { "X-Machine-Name": "ci-runner" });
    const machines = await listMachines(user.apiKey);
    expect(machines.map((m) => m.value)).toEqual(["ci-runner"]);
  });

  it("registers nothing when no machine value is present", async () => {
    await postHeartbeat(user.apiKey, { entity: "/e.ts", type: "file", time: nowEpoch() });
    expect(await listMachines(user.apiKey)).toEqual([]);
  });

  it("does not register a machine for a hidden heartbeat", async () => {
    await call(RULES, {
      method: "PUT",
      headers: authJson(user.apiKey),
      body: JSON.stringify([{ action: "hide", source: "project", operation: "equals", source_value: "secret" }]),
    });
    const res = await postHeartbeat(user.apiKey, {
      entity: "/f.ts",
      type: "file",
      time: nowEpoch(),
      project: "secret",
      machine: "ghost",
    });
    expect(res.status).toBe(201); // success-shaped, but dropped
    expect(await listMachines(user.apiKey)).toEqual([]);
  });

  it("bulk: upserts each distinct device once", async () => {
    const res = await call(`${HEARTBEATS}.bulk`, {
      method: "POST",
      headers: authJson(user.apiKey),
      body: JSON.stringify([
        { entity: "/g.ts", type: "file", time: nowEpoch(), machine: "laptop" },
        { entity: "/h.ts", type: "file", time: nowEpoch(), machine: "laptop" },
        { entity: "/i.ts", type: "file", time: nowEpoch(), machine: "desktop" },
      ]),
    });
    expect(res.status).toBe(202);
    const machines = await listMachines(user.apiKey);
    expect(machines.map((m) => m.value).sort()).toEqual(["desktop", "laptop"]);
  });
});

describe("GET /machine_names", () => {
  it("returns {data:[]} for a user with no machines", async () => {
    const res = await call(MACHINES, { headers: bearer(user.apiKey) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it("orders machines by last_seen_at descending", async () => {
    // Seed two machines with explicit, distinct last_seen_at values.
    await env.DB.prepare(
      `INSERT INTO machine_names (id, user_id, value, last_seen_at, created_at)
       VALUES (?, ?, 'old', '2026-05-01 10:00:00', '2026-05-01 10:00:00'),
              (?, ?, 'new', '2026-05-10 10:00:00', '2026-05-10 10:00:00')`,
    )
      .bind(crypto.randomUUID(), user.userId, crypto.randomUUID(), user.userId)
      .run();

    const machines = await listMachines(user.apiKey);
    expect(machines.map((m) => m.value)).toEqual(["new", "old"]);
  });

  it("isolates machines per user", async () => {
    const bob = await seedUser({ username: "bob", email: "bob@example.test" });
    await postHeartbeat(bob.apiKey, { entity: "/x.ts", type: "file", time: nowEpoch(), machine: "bob-box" });

    expect(await listMachines(user.apiKey)).toEqual([]);
    const bobMachines = await listMachines(bob.apiKey);
    expect(bobMachines.map((m) => m.value)).toEqual(["bob-box"]);

    await env.KV.delete(`apikey:${bob.apiKeyHash}`);
  });

  it("returns 401 when unauthenticated", async () => {
    expect((await call(MACHINES)).status).toBe(401);
  });
});
