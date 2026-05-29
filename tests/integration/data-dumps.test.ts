/**
 * Integration tests for Data Dumps (specs/102-data-dumps/): request/list,
 * dedupe, validation, 503-when-unbound, the cron build → download round-trip,
 * expiry purge, and cross-user isolation. R2 is provided by the test pool.
 */
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { seedUser, truncate, type SeededUser } from "../helpers/fixtures";
import { processPendingDumps, purgeExpiredDumps } from "../../src/cron/data-dumps";

const BASE = "https://test.cloudtime.dev";
const DUMPS = "/api/v1/users/current/data_dumps";

let user: SeededUser;

beforeEach(async () => {
  user = await seedUser({ username: "alice", email: "alice@example.test", timezone: "UTC" });
});

afterEach(async () => {
  await truncate("data_dumps", "summaries", "heartbeats", "users");
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

interface DumpShape {
  id: string;
  type: string;
  status: string;
  download_url?: string;
  created_at: string;
  expires_at?: string;
}

function postDump(apiKey: string, type: string): Promise<Response> {
  return call(DUMPS, { method: "POST", headers: authJson(apiKey), body: JSON.stringify({ type }) });
}
async function listDumps(apiKey: string): Promise<DumpShape[]> {
  const res = await call(DUMPS, { headers: bearer(apiKey) });
  return ((await res.json()) as { data: DumpShape[] }).data;
}

describe("data_dumps (R2 bound)", () => {
  it("POST creates a pending dump", async () => {
    const res = await postDump(user.apiKey, "full");
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: DumpShape };
    expect(data.id).toMatch(/[0-9a-f-]{36}/);
    expect(data.type).toBe("full");
    expect(data.status).toBe("pending");
  });

  it("dedupes an in-flight request of the same type", async () => {
    const first = ((await (await postDump(user.apiKey, "full")).json()) as { data: DumpShape }).data;
    const second = ((await (await postDump(user.apiKey, "full")).json()) as { data: DumpShape }).data;
    expect(second.id).toBe(first.id);
    expect(await listDumps(user.apiKey)).toHaveLength(1);
  });

  it("400s on an unknown type", async () => {
    expect((await postDump(user.apiKey, "everything")).status).toBe(400);
  });

  it("requires authentication", async () => {
    expect((await call(DUMPS)).status).toBe(401);
    expect(
      (await call(DUMPS, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status,
    ).toBe(401);
  });

  it("cron builds the dump, then it is downloadable with the export bundle", async () => {
    await env.DB.prepare(
      `INSERT INTO summaries (user_id, date, project, language, total_seconds) VALUES (?, '2026-05-01', 'api', 'TypeScript', 3600)`,
    ).bind(user.userId).run();
    await env.DB.prepare(
      `INSERT INTO heartbeats (id, user_id, entity, type, time, is_write, created_at)
       VALUES (?, ?, '/x.ts', 'file', 1717000000, 0, datetime('now'))`,
    ).bind(crypto.randomUUID(), user.userId).run();

    const id = ((await (await postDump(user.apiKey, "full")).json()) as { data: DumpShape }).data.id;

    await processPendingDumps(env);

    const dumps = await listDumps(user.apiKey);
    expect(dumps[0].status).toBe("completed");
    expect(dumps[0].download_url).toContain(`/data_dumps/${id}/download`);
    expect(dumps[0].expires_at).toBeTruthy();

    const dl = await call(new URL(dumps[0].download_url as string).pathname, { headers: bearer(user.apiKey) });
    expect(dl.status).toBe(200);
    const bundle = (await dl.json()) as Record<string, unknown> & { user: Record<string, unknown> };
    expect(Object.keys(bundle).sort()).toEqual(["daily", "heartbeats", "summaries", "user"]);
    // secrets never exported
    expect(bundle.user).not.toHaveProperty("api_key_hash");
    expect((bundle.summaries as unknown[]).length).toBe(1);
  });

  it("daily export bundles only user + summaries", async () => {
    const id = ((await (await postDump(user.apiKey, "daily")).json()) as { data: DumpShape }).data.id;
    await processPendingDumps(env);
    const dumps = await listDumps(user.apiKey);
    const dl = await call(new URL(dumps[0].download_url as string).pathname, { headers: bearer(user.apiKey) });
    const bundle = (await dl.json()) as Record<string, unknown>;
    expect(Object.keys(bundle).sort()).toEqual(["summaries", "user"]);
    expect(id).toBeTruthy();
  });

  it("purges expired dumps: status expired, download 404", async () => {
    const id = ((await (await postDump(user.apiKey, "daily")).json()) as { data: DumpShape }).data.id;
    await processPendingDumps(env);
    // force expiry
    await env.DB.prepare("UPDATE data_dumps SET expires_at = '2000-01-01 00:00:00' WHERE id = ?").bind(id).run();

    const beforePurge = await listDumps(user.apiKey);
    expect(beforePurge[0].status).toBe("expired");
    expect(beforePurge[0].download_url).toBeUndefined();
    expect((await call(`${DUMPS}/${id}/download`, { headers: bearer(user.apiKey) })).status).toBe(404);

    await purgeExpiredDumps(env);

    const dumps = await listDumps(user.apiKey);
    expect(dumps[0].status).toBe("expired");
    expect(dumps[0].download_url).toBeUndefined();

    const dl = await call(`${DUMPS}/${id}/download`, { headers: bearer(user.apiKey) });
    expect(dl.status).toBe(404);
  });

  it("isolates dumps and downloads per user", async () => {
    const bob = await seedUser({ username: "bob", email: "bob@example.test" });
    const bobId = ((await (await postDump(bob.apiKey, "daily")).json()) as { data: DumpShape }).data.id;
    await processPendingDumps(env);

    expect(await listDumps(user.apiKey)).toEqual([]);
    const dl = await call(`${DUMPS}/${bobId}/download`, { headers: bearer(user.apiKey) });
    expect(dl.status).toBe(404);

    await env.KV.delete(`apikey:${bob.apiKeyHash}`);
  });
});

describe("data_dumps (R2 unbound)", () => {
  it("503s on both endpoints when R2 is not configured", async () => {
    const saved = env.R2_BUCKET;
    (env as { R2_BUCKET?: unknown }).R2_BUCKET = undefined;
    try {
      expect((await call(DUMPS, { headers: bearer(user.apiKey) })).status).toBe(503);
      expect((await postDump(user.apiKey, "full")).status).toBe(503);
    } finally {
      (env as { R2_BUCKET?: unknown }).R2_BUCKET = saved;
    }
  });
});
