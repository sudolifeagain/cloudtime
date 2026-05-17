/**
 * Integration tests for GET /api/v1/users/current/goals filter parameters
 * (Issue #111).
 *
 * Seeds four goals covering every combination of (is_enabled, is_snoozed)
 * and verifies that each combination of `?enabled=` / `?snoozed=` filters
 * returns the expected subset.
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
  await truncate("goals", "users");
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

async function seedGoal(opts: {
  userId: string;
  title: string;
  isEnabled?: boolean;
  isSnoozed?: boolean;
  createdAt?: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO goals (id, user_id, title, type, delta, target_seconds,
                        is_enabled, is_snoozed, is_inverse,
                        created_at, modified_at)
     VALUES (?, ?, ?, 'coding', 'day', 3600,
             ?, ?, 0,
             COALESCE(?, datetime('now')), datetime('now'))`,
  )
    .bind(
      crypto.randomUUID(),
      opts.userId,
      opts.title,
      opts.isEnabled === false ? 0 : 1,
      opts.isSnoozed ? 1 : 0,
      opts.createdAt ?? null,
    )
    .run();
}

beforeEach(async () => {
  await seedGoal({ userId: user.userId, title: "active",       isEnabled: true,  isSnoozed: false, createdAt: "2026-05-01 10:00:00" });
  await seedGoal({ userId: user.userId, title: "snoozed",      isEnabled: true,  isSnoozed: true,  createdAt: "2026-05-02 10:00:00" });
  await seedGoal({ userId: user.userId, title: "disabled",     isEnabled: false, isSnoozed: false, createdAt: "2026-05-03 10:00:00" });
  await seedGoal({ userId: user.userId, title: "disabled+snz", isEnabled: false, isSnoozed: true,  createdAt: "2026-05-04 10:00:00" });
});

async function listGoals(query: string): Promise<string[]> {
  const res = await call(`/api/v1/users/current/goals${query}`, {
    headers: auth(user.apiKey),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Array<{ title: string }> };
  return body.data.map((g) => g.title);
}

describe("GET /goals filter query parameters (#111)", () => {
  it("no filter returns all 4 goals", async () => {
    expect(await listGoals("")).toEqual(["active", "snoozed", "disabled", "disabled+snz"]);
  });

  it("enabled=true returns only enabled goals (both snoozed and not)", async () => {
    expect(await listGoals("?enabled=true")).toEqual(["active", "snoozed"]);
  });

  it("enabled=false returns only disabled goals", async () => {
    expect(await listGoals("?enabled=false")).toEqual(["disabled", "disabled+snz"]);
  });

  it("snoozed=true returns only snoozed goals (regardless of enabled flag)", async () => {
    expect(await listGoals("?snoozed=true")).toEqual(["snoozed", "disabled+snz"]);
  });

  it("snoozed=false returns only non-snoozed goals", async () => {
    expect(await listGoals("?snoozed=false")).toEqual(["active", "disabled"]);
  });

  it("enabled=true&snoozed=false returns the single 'active' goal", async () => {
    expect(await listGoals("?enabled=true&snoozed=false")).toEqual(["active"]);
  });

  it("accepts 1 / 0 as truthy / falsy values", async () => {
    expect(await listGoals("?enabled=1&snoozed=0")).toEqual(["active"]);
    expect(await listGoals("?enabled=0")).toEqual(["disabled", "disabled+snz"]);
  });

  it("rejects an invalid boolean value with 400", async () => {
    const res = await call("/api/v1/users/current/goals?enabled=maybe", {
      headers: auth(user.apiKey),
    });
    expect(res.status).toBe(400);
  });
});
