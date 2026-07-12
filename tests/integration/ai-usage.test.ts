/**
 * Integration tests for GET /users/current/ai/usage (Issue #200, US2).
 *
 * Exercises the owner-only usage summary against a real in-memory D1
 * (vitest-pool-workers): token trends, estimated cost with/without prices
 * (`null` + `missing_price_count`), single-currency selection + `mixed_currency`
 * exclusion, deterministic range-resolution `400`s, user scoping, and the
 * owner-only `401`. The endpoint reads the `ai_daily_usage` rollup, so tests seed
 * rollup rows directly rather than driving the cron.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import type { components } from "../../src/types/generated";
import { seedUser, truncate, type SeededUser } from "../helpers/fixtures";

type AIUsageSummary = components["schemas"]["AIUsageSummary"];

let user: SeededUser;
let other: SeededUser;

beforeEach(async () => {
  user = await seedUser({ username: "alice", timezone: "UTC" });
  other = await seedUser({ username: "bob", timezone: "UTC" });
});

afterEach(async () => {
  await truncate("ai_daily_usage", "ai_model_prices", "users");
  await env.KV.delete(`apikey:${user.apiKeyHash}`);
  await env.KV.delete(`apikey:${other.apiKeyHash}`);
});

async function callWorker(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const req = new Request(`https://test.cloudtime.dev${path}`, init);
  const res = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function authHeader(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

const USAGE = "/api/v1/users/current/ai/usage";

async function insertUsage(
  userId: string,
  fields: Partial<{
    day: string;
    provider: string;
    model: string;
    agent: string;
    project: string;
    input_tokens: number;
    output_tokens: number;
    prompt_length_total: number;
    prompt_length_count: number;
    heartbeat_count: number;
  }> = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ai_daily_usage
       (user_id, day, provider, model, agent, project,
        input_tokens, output_tokens, prompt_length_total, prompt_length_count, heartbeat_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      userId,
      fields.day ?? "2026-03-14",
      fields.provider ?? "openai",
      fields.model ?? "gpt-4o",
      fields.agent ?? "vscode",
      fields.project ?? "cloudtime",
      fields.input_tokens ?? 0,
      fields.output_tokens ?? 0,
      fields.prompt_length_total ?? 0,
      fields.prompt_length_count ?? 0,
      fields.heartbeat_count ?? 1,
    )
    .run();
}

async function insertPrice(
  userId: string,
  fields: Partial<{
    provider: string;
    model: string;
    currency: string;
    input_cost_per_mtok: number | null;
    output_cost_per_mtok: number | null;
    effective_from: string;
    is_enabled: number;
  }> = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ai_model_prices
       (id, user_id, provider, model, currency, input_cost_per_mtok, output_cost_per_mtok,
        effective_from, is_default, is_enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'), datetime('now'))`,
  )
    .bind(
      crypto.randomUUID(),
      userId,
      fields.provider ?? "openai",
      fields.model ?? "gpt-4o",
      fields.currency ?? "USD",
      fields.input_cost_per_mtok ?? null,
      fields.output_cost_per_mtok ?? null,
      fields.effective_from ?? "2026-01-01 00:00:00",
      fields.is_enabled ?? 1,
    )
    .run();
}

const RANGE = "?start=2026-03-01&end=2026-03-31";

async function getUsage(path: string, apiKey = user.apiKey): Promise<{ status: number; data: AIUsageSummary }> {
  const res = await callWorker(USAGE + path, { headers: authHeader(apiKey) });
  const body = (await res.json()) as { data: AIUsageSummary };
  return { status: res.status, data: body.data };
}

describe("GET /ai/usage — token trends + cost", () => {
  it("returns token totals, a daily trend, and dimensional breakdowns", async () => {
    await insertUsage(user.userId, {
      input_tokens: 1_000_000,
      output_tokens: 500_000,
      prompt_length_total: 400,
      prompt_length_count: 2,
      heartbeat_count: 2,
    });

    const { status, data } = await getUsage(RANGE);
    expect(status).toBe(200);
    expect(data.start).toBe("2026-03-01");
    expect(data.end).toBe("2026-03-31");
    expect(data.timezone).toBe("UTC");
    expect(data.totals.input_tokens).toBe(1_000_000);
    expect(data.totals.output_tokens).toBe(500_000);
    expect(data.totals.heartbeat_count).toBe(2);
    expect(data.totals.prompt_length_avg).toBeCloseTo(200, 9);
    expect(data.daily).toEqual([expect.objectContaining({ date: "2026-03-14" })]);
    expect(data.by_provider).toEqual([expect.objectContaining({ provider: "openai" })]);
    expect(data.by_model[0]).toMatchObject({ provider: "openai", model: "gpt-4o" });
    expect(data.by_agent[0].agent).toBe("vscode");
    expect(data.by_project[0].project).toBe("cloudtime");
  });

  it("prices fully-covered buckets and reports the currency", async () => {
    await insertUsage(user.userId, { input_tokens: 1_000_000, output_tokens: 500_000 });
    await insertPrice(user.userId, { input_cost_per_mtok: 2.5, output_cost_per_mtok: 10 });

    const { data } = await getUsage(RANGE);
    expect(data.currency).toBe("USD");
    expect(data.totals.estimated_cost).toBeCloseTo(7.5, 9);
    expect(data.totals.missing_price_count).toBe(0);
    expect(data.mixed_currency).toBeUndefined();
  });

  it("reports null cost + missing_price_count when no price matches", async () => {
    await insertUsage(user.userId, { input_tokens: 100, heartbeat_count: 3 });

    const { data } = await getUsage(RANGE);
    expect(data.currency).toBe("USD");
    expect(data.totals.estimated_cost).toBeNull();
    expect(data.totals.missing_price_count).toBe(3);
  });

  it("prices a NEW Anthropic version from its family default, with no owner row", async () => {
    // A claude-opus version that did not exist when the code shipped still
    // resolves via the opus family, so defaults do not go stale on point releases.
    await insertUsage(user.userId, {
      provider: "anthropic",
      model: "claude-opus-4-9",
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });

    const { data } = await getUsage(RANGE);
    expect(data.currency).toBe("USD");
    expect(data.totals.estimated_cost).toBeCloseTo(30, 6); // $5/M in + $25/M out
    expect(data.totals.missing_price_count).toBe(0);
    expect(data.by_model.find((m) => m.model === "claude-opus-4-9")?.estimated_cost).toBeCloseTo(30, 6);
  });

  it("prices a codex gpt-5.6 tier from the shipped default, with no owner row", async () => {
    await insertUsage(user.userId, {
      provider: "openai",
      model: "gpt-5.6-luna",
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    });

    const { data } = await getUsage(RANGE);
    expect(data.totals.estimated_cost).toBeCloseTo(7, 6); // $1/M in + $6/M out
  });

  it("keeps an unknown model unpriced even with defaults shipped (missing_price_count)", async () => {
    await insertUsage(user.userId, {
      provider: "openai",
      model: "gpt-5.7",
      input_tokens: 1_000_000,
      heartbeat_count: 4,
    });

    const { data } = await getUsage(RANGE);
    expect(data.totals.estimated_cost).toBeNull();
    expect(data.totals.missing_price_count).toBe(4);
  });

  it("lets an owner price override the shipped family default", async () => {
    await insertUsage(user.userId, {
      provider: "anthropic",
      model: "claude-opus-4-8",
      input_tokens: 1_000_000,
      output_tokens: 0,
    });
    await insertPrice(user.userId, {
      provider: "anthropic",
      model: "claude-opus-4-8",
      input_cost_per_mtok: 1,
      output_cost_per_mtok: 1,
    });

    const { data } = await getUsage(RANGE);
    expect(data.totals.estimated_cost).toBeCloseTo(1, 6); // owner $1/M, not the $5/M opus default
  });

  it("selects one currency and flags mixed_currency, excluding off-currency cost", async () => {
    await insertUsage(user.userId, { provider: "openai", model: "gpt-4o", input_tokens: 1_000_000, heartbeat_count: 3 });
    await insertUsage(user.userId, { provider: "anthropic", model: "claude", input_tokens: 1_000_000, heartbeat_count: 1 });
    await insertPrice(user.userId, { provider: "openai", model: "gpt-4o", currency: "USD", input_cost_per_mtok: 2 });
    await insertPrice(user.userId, { provider: "anthropic", model: "claude", currency: "EUR", input_cost_per_mtok: 3 });

    const { data } = await getUsage(RANGE);
    expect(data.currency).toBe("USD");
    expect(data.mixed_currency).toBe(true);
    expect(data.totals.estimated_cost).toBeCloseTo(2, 9);
    expect(data.totals.missing_price_count).toBe(1);
  });

  it("scopes the summary to the authenticated user", async () => {
    await insertUsage(user.userId, { input_tokens: 100 });
    await insertUsage(other.userId, { input_tokens: 999 });

    const { data } = await getUsage(RANGE);
    expect(data.totals.input_tokens).toBe(100);
  });

  it("defaults to a trailing 30-day window when no range is supplied", async () => {
    const { status, data } = await getUsage("?days=30");
    expect(status).toBe(200);
    const span =
      (new Date(data.end + "T00:00:00Z").getTime() - new Date(data.start + "T00:00:00Z").getTime()) /
        86_400_000 +
      1;
    expect(span).toBe(30);
  });
});

describe("GET /ai/usage — validation + auth", () => {
  it.each([
    ["start without end", "?start=2026-03-01"],
    ["end without start", "?end=2026-03-31"],
    ["start after end", "?start=2026-03-31&end=2026-03-01"],
    ["span over 366 days", "?start=2025-01-01&end=2026-06-01"],
    ["invalid timezone", "?days=7&timezone=Not/AZone"],
    ["days over maximum", "?days=400"],
  ])("returns 400 for %s", async (_label, qs) => {
    const res = await callWorker(USAGE + qs, { headers: authHeader(user.apiKey) });
    expect(res.status).toBe(400);
  });

  it("returns 401 without authentication (owner-only)", async () => {
    const res = await callWorker(USAGE + RANGE);
    expect(res.status).toBe(401);
  });
});
