/**
 * Integration tests for the Goals CRUD endpoints (specs/100-goals-crud/).
 * Exercises create / update / delete against an in-memory D1, including
 * validation failures, immutable-field rejection, cross-user 404 isolation,
 * and authentication. Mirrors the scenarios in quickstart.md (A–H).
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
const GOALS = "/api/v1/users/current/goals";

let user: SeededUser;

beforeEach(async () => {
  user = await seedUser({ username: "alice", email: "alice@example.test", timezone: "UTC" });
});

afterEach(async () => {
  await truncate("goals", "users");
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

interface GoalShape {
  id: string;
  title: string;
  type: string;
  delta: string;
  target_seconds: number;
  is_enabled: boolean;
  is_snoozed: boolean;
  is_inverse: boolean;
  languages: string[];
  editors: string[];
  projects: string[];
  created_at: string;
  modified_at: string;
}

async function createGoal(apiKey: string, body: Record<string, unknown>): Promise<Response> {
  return call(GOALS, { method: "POST", headers: authJson(apiKey), body: JSON.stringify(body) });
}

// --- Scenario A: minimal create ---------------------------------------------

describe("POST /goals (create)", () => {
  it("creates a minimal coding goal with defaults applied (201)", async () => {
    const res = await createGoal(user.apiKey, {
      title: "Code 1 hour per day",
      type: "coding",
      delta: "day",
      target_seconds: 3600,
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: GoalShape };
    expect(data.id).toMatch(/[0-9a-f-]{36}/);
    expect(data.title).toBe("Code 1 hour per day");
    expect(data.is_enabled).toBe(true);
    expect(data.is_snoozed).toBe(false);
    expect(data.is_inverse).toBe(false);
    expect(data.languages).toEqual([]);
    expect(data.created_at).toBeTruthy();
    expect(data.modified_at).toBeTruthy();
  });

  // --- Scenario B: filtered create ---
  it("persists and echoes a language filter (201)", async () => {
    const res = await createGoal(user.apiKey, {
      title: "5h TypeScript / week",
      type: "languages",
      delta: "week",
      target_seconds: 18000,
      languages: ["TypeScript", "TypeScript"],
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: GoalShape };
    expect(data.type).toBe("languages");
    expect(data.languages).toEqual(["TypeScript"]); // de-duplicated
  });

  it("ignores server-generated fields supplied in the body", async () => {
    const res = await createGoal(user.apiKey, {
      id: "client-chosen-id",
      created_at: "2000-01-01T00:00:00Z",
      title: "x",
      type: "coding",
      delta: "day",
      target_seconds: 60,
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: GoalShape };
    expect(data.id).not.toBe("client-chosen-id");
    expect(data.created_at).not.toBe("2000-01-01T00:00:00Z");
  });

  // --- Scenario C: validation failures ---
  it("rejects invalid bodies with 400", async () => {
    const bad: Array<Record<string, unknown>> = [
      { title: "   ", type: "coding", delta: "day", target_seconds: 3600 },
      { title: "x", type: "coding", delta: "day", target_seconds: 0 },
      { title: "x", type: "coding", delta: "day", target_seconds: 700000 },
      { title: "x", type: "music", delta: "day", target_seconds: 3600 },
      { title: "x", type: "coding", delta: "fortnight", target_seconds: 3600 },
      { title: "x", type: "coding", delta: "day", target_seconds: 3600, languages: ["Go"] },
      { title: "x", type: "languages", delta: "day", target_seconds: 3600 },
    ];
    for (const body of bad) {
      const res = await createGoal(user.apiKey, body);
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      expect(typeof json.error).toBe("string");
    }
    // None of the bad requests created a row.
    const list = await call(GOALS, { headers: { Authorization: `Bearer ${user.apiKey}` } });
    expect((await list.json()) as unknown).toEqual({ data: [] });
  });

  it("rejects a malformed JSON body with 400", async () => {
    const res = await call(GOALS, {
      method: "POST",
      headers: authJson(user.apiKey),
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  // --- Scenario H: unauthenticated ---
  it("returns 401 when unauthenticated", async () => {
    const res = await call(GOALS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x", type: "coding", delta: "day", target_seconds: 60 }),
    });
    expect(res.status).toBe(401);
  });
});

// --- Scenario D & E: update --------------------------------------------------

describe("PATCH /goals/:goal_id (update)", () => {
  async function createDefault(): Promise<string> {
    const res = await createGoal(user.apiKey, {
      title: "Original",
      type: "languages",
      delta: "day",
      target_seconds: 3600,
      languages: ["Go"],
    });
    return ((await res.json()) as { data: GoalShape }).data.id;
  }

  it("updates only the provided fields and advances modified_at", async () => {
    const id = await createDefault();
    // Force an old modified_at so the advance is unambiguous.
    await env.DB.prepare("UPDATE goals SET modified_at = '2026-01-01 00:00:00' WHERE id = ?")
      .bind(id)
      .run();

    const res = await call(`${GOALS}/${id}`, {
      method: "PATCH",
      headers: authJson(user.apiKey),
      body: JSON.stringify({ target_seconds: 7200, is_snoozed: true }),
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: GoalShape };
    expect(data.target_seconds).toBe(7200);
    expect(data.is_snoozed).toBe(true);
    expect(data.title).toBe("Original"); // untouched
    expect(data.languages).toEqual(["Go"]); // untouched
    expect(data.modified_at > "2026-01-01T00:00:00Z").toBe(true);
  });

  it("rejects immutable type/delta and an empty body with 400", async () => {
    const id = await createDefault();
    for (const body of [{ type: "coding" }, { delta: "week" }, {}]) {
      const res = await call(`${GOALS}/${id}`, {
        method: "PATCH",
        headers: authJson(user.apiKey),
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it("rejects clearing a filtered goal's array with 400", async () => {
    const id = await createDefault();
    const res = await call(`${GOALS}/${id}`, {
      method: "PATCH",
      headers: authJson(user.apiKey),
      body: JSON.stringify({ languages: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown goal id", async () => {
    const res = await call(`${GOALS}/missing`, {
      method: "PATCH",
      headers: authJson(user.apiKey),
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await call(`${GOALS}/anything`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(401);
  });
});

// --- Scenario F: delete ------------------------------------------------------

describe("DELETE /goals/:goal_id", () => {
  it("deletes an owned goal (204) and removes it from subsequent reads", async () => {
    const created = await createGoal(user.apiKey, {
      title: "to delete",
      type: "coding",
      delta: "day",
      target_seconds: 60,
    });
    const id = ((await created.json()) as { data: GoalShape }).data.id;

    const del = await call(`${GOALS}/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${user.apiKey}` },
    });
    expect(del.status).toBe(204);
    expect(await del.text()).toBe("");

    const get = await call(`${GOALS}/${id}`, { headers: { Authorization: `Bearer ${user.apiKey}` } });
    expect(get.status).toBe(404);

    const list = await call(GOALS, { headers: { Authorization: `Bearer ${user.apiKey}` } });
    const { data } = (await list.json()) as { data: GoalShape[] };
    expect(data.find((g) => g.id === id)).toBeUndefined();
  });

  it("returns 404 for an unknown goal id", async () => {
    const res = await call(`${GOALS}/missing`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${user.apiKey}` },
    });
    expect(res.status).toBe(404);
  });

  it("returns 401 when unauthenticated", async () => {
    // application/json content-type bypasses the form-style CSRF guard, so the
    // request reaches authMiddleware (the path real API clients take).
    const res = await call(`${GOALS}/anything`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(401);
  });
});

// --- Scenario G: cross-user isolation ---------------------------------------

describe("cross-user isolation", () => {
  it("returns 404 (and leaves the row untouched) for PATCH/DELETE on another user's goal", async () => {
    const bob = await seedUser({ username: "bob", email: "bob@example.test" });
    const created = await createGoal(bob.apiKey, {
      title: "bob's goal",
      type: "coding",
      delta: "day",
      target_seconds: 3600,
    });
    const bobGoalId = ((await created.json()) as { data: GoalShape }).data.id;

    const patch = await call(`${GOALS}/${bobGoalId}`, {
      method: "PATCH",
      headers: authJson(user.apiKey),
      body: JSON.stringify({ title: "hijacked" }),
    });
    expect(patch.status).toBe(404);

    const del = await call(`${GOALS}/${bobGoalId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${user.apiKey}` },
    });
    expect(del.status).toBe(404);

    // Bob still sees his goal unchanged.
    const bobRead = await call(`${GOALS}/${bobGoalId}`, {
      headers: { Authorization: `Bearer ${bob.apiKey}` },
    });
    expect(bobRead.status).toBe(200);
    const { data } = (await bobRead.json()) as { data: GoalShape };
    expect(data.title).toBe("bob's goal");

    await env.KV.delete(`apikey:${bob.apiKeyHash}`);
  });
});
