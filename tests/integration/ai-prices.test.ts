/**
 * Integration tests for the AI model price endpoints (Issue #200, US3).
 *
 * Exercises GET/POST /ai/prices and GET/PATCH/DELETE /ai/prices/{id} against a
 * real in-memory D1 (vitest-pool-workers): create + round-trip, list filters
 * (active_on / include_disabled / provider), validation 400s, the enabled-window
 * overlap rule, immutability + empty-body 400s, default-row protection (404),
 * cross-user / unknown-id 404s, and owner-only 401.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { seedUser, truncate, type SeededUser } from "../helpers/fixtures";

let user: SeededUser;
let other: SeededUser;

beforeEach(async () => {
  user = await seedUser({ username: "alice", timezone: "UTC" });
  other = await seedUser({ username: "bob", timezone: "UTC" });
});

afterEach(async () => {
  await truncate("ai_model_prices", "users");
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

function jsonHeaders(apiKey: string): Record<string, string> {
  return { "Content-Type": "application/json", ...authHeader(apiKey) };
}

const PRICES = "/api/v1/users/current/ai/prices";

function validPrice(overrides: Record<string, unknown> = {}) {
  return {
    provider: "openai",
    model: "gpt-4o",
    effective_from: "2026-01-01T00:00:00Z",
    input_cost_per_mtok: 2.5,
    output_cost_per_mtok: 10,
    ...overrides,
  };
}

/** Insert a price row directly (for default / cross-user rows the API can't create). */
async function insertPrice(opts: {
  id: string;
  userId: string;
  provider?: string;
  model?: string;
  effective_from?: string;
  effective_to?: string | null;
  is_default?: number;
  is_enabled?: number;
  input_cost_per_mtok?: number | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ai_model_prices
       (id, user_id, provider, model, currency, input_cost_per_mtok,
        effective_from, effective_to, is_default, is_enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  )
    .bind(
      opts.id,
      opts.userId,
      opts.provider ?? "openai",
      opts.model ?? "gpt-4o",
      opts.input_cost_per_mtok ?? 1,
      opts.effective_from ?? "2026-01-01 00:00:00",
      opts.effective_to ?? null,
      opts.is_default ?? 0,
      opts.is_enabled ?? 1,
    )
    .run();
}

describe("POST /ai/prices", () => {
  it("creates an owner row and returns it as is_default=false", async () => {
    const res = await callWorker(PRICES, {
      method: "POST",
      headers: jsonHeaders(user.apiKey),
      body: JSON.stringify(validPrice()),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.id).toBeTruthy();
    expect(body.data.provider).toBe("openai");
    expect(body.data.model).toBe("gpt-4o");
    expect(body.data.currency).toBe("USD");
    expect(body.data.input_cost_per_mtok).toBe(2.5);
    expect(body.data.output_cost_per_mtok).toBe(10);
    expect(body.data.is_default).toBe(false);
    expect(body.data.is_enabled).toBe(true);
    expect(body.data.effective_to).toBeNull();
  });

  it.each([
    ["no rate field", { provider: "p", model: "m", effective_from: "2026-01-01T00:00:00Z" }],
    ["lower-case currency", validPrice({ currency: "usd" })],
    ["effective_to not after from", validPrice({ effective_to: "2026-01-01T00:00:00Z" })],
    ["missing provider", { model: "m", effective_from: "2026-01-01T00:00:00Z", input_cost_per_mtok: 1 }],
    ["non-http source_url", validPrice({ source_url: "data:text/html,x" })],
    ["rate above cap", validPrice({ input_cost_per_mtok: 2_000_000 })],
  ])("rejects %s with 400", async (_label, bad) => {
    const res = await callWorker(PRICES, {
      method: "POST",
      headers: jsonHeaders(user.apiKey),
      body: JSON.stringify(bad),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an enabled window overlapping an existing enabled row with 400", async () => {
    const first = await callWorker(PRICES, {
      method: "POST",
      headers: jsonHeaders(user.apiKey),
      body: JSON.stringify(validPrice({ effective_from: "2026-01-01T00:00:00Z", effective_to: "2026-06-01T00:00:00Z" })),
    });
    expect(first.status).toBe(201);

    const overlap = await callWorker(PRICES, {
      method: "POST",
      headers: jsonHeaders(user.apiKey),
      body: JSON.stringify(validPrice({ effective_from: "2026-03-01T00:00:00Z", effective_to: "2026-09-01T00:00:00Z" })),
    });
    expect(overlap.status).toBe(400);
  });

  it("allows a disabled overlapping row (disabled rows are ignored in estimation)", async () => {
    await callWorker(PRICES, {
      method: "POST",
      headers: jsonHeaders(user.apiKey),
      body: JSON.stringify(validPrice({ effective_to: "2026-06-01T00:00:00Z" })),
    });
    const disabled = await callWorker(PRICES, {
      method: "POST",
      headers: jsonHeaders(user.apiKey),
      body: JSON.stringify(validPrice({ is_enabled: false })),
    });
    expect(disabled.status).toBe(201);
  });

  it("returns 401 without authentication", async () => {
    const res = await callWorker(PRICES, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validPrice()),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /ai/prices", () => {
  it("lists owner rows, excludes disabled unless include_disabled=true", async () => {
    await callWorker(PRICES, {
      method: "POST",
      headers: jsonHeaders(user.apiKey),
      body: JSON.stringify(validPrice({ model: "gpt-4o", effective_to: "2026-06-01T00:00:00Z" })),
    });
    await callWorker(PRICES, {
      method: "POST",
      headers: jsonHeaders(user.apiKey),
      body: JSON.stringify(validPrice({ model: "gpt-4o-mini", is_enabled: false })),
    });

    // Owner rows only (shipped is_default rows are always present alongside them).
    const enabled = await callWorker(PRICES, { headers: authHeader(user.apiKey) });
    const enabledBody = (await enabled.json()) as { data: { is_default: boolean }[] };
    expect(enabledBody.data.filter((r) => !r.is_default)).toHaveLength(1);

    const all = await callWorker(`${PRICES}?include_disabled=true`, { headers: authHeader(user.apiKey) });
    const allBody = (await all.json()) as { data: { is_default: boolean }[] };
    expect(allBody.data.filter((r) => !r.is_default)).toHaveLength(2);
  });

  it("filters by active_on window and by provider", async () => {
    await callWorker(PRICES, {
      method: "POST",
      headers: jsonHeaders(user.apiKey),
      body: JSON.stringify(validPrice({ provider: "openai", effective_from: "2026-01-01T00:00:00Z", effective_to: "2026-02-01T00:00:00Z" })),
    });
    await callWorker(PRICES, {
      method: "POST",
      headers: jsonHeaders(user.apiKey),
      body: JSON.stringify(validPrice({ provider: "anthropic", model: "claude-opus-4", effective_from: "2026-03-01T00:00:00Z" })),
    });

    const active = await callWorker(`${PRICES}?active_on=2026-01-15T00:00:00Z`, { headers: authHeader(user.apiKey) });
    const activeBody = (await active.json()) as { data: { provider: string; is_default: boolean }[] };
    const activeOwner = activeBody.data.filter((r) => !r.is_default);
    expect(activeOwner).toHaveLength(1);
    expect(activeOwner[0].provider).toBe("openai");

    const byProvider = await callWorker(`${PRICES}?provider=anthropic`, { headers: authHeader(user.apiKey) });
    const byProviderBody = (await byProvider.json()) as { data: { provider: string; is_default: boolean }[] };
    const byProviderOwner = byProviderBody.data.filter((r) => !r.is_default);
    expect(byProviderOwner).toHaveLength(1);
    expect(byProviderOwner[0].provider).toBe("anthropic");
  });

  it("lists shipped default prices (is_default) even with no owner rows configured", async () => {
    const res = await callWorker(`${PRICES}?provider=openai`, { headers: authHeader(user.apiKey) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { model: string; is_default: boolean; input_cost_per_mtok?: number; output_cost_per_mtok?: number }[];
    };
    const defaults = body.data.filter((r) => r.is_default);
    expect(defaults.length).toBeGreaterThan(0);
    // gpt-5.6 tiers (codex 5.6) ship out of the box.
    expect(defaults.find((r) => r.model === "gpt-5.6-luna")).toMatchObject({
      is_default: true,
      input_cost_per_mtok: 1,
      output_cost_per_mtok: 6,
    });
  });

  it("does not expose a shipped default as an addressable row (single-row endpoints 404)", async () => {
    // Synthetic default ids never exist in D1, so id existence is not leaked and
    // defaults cannot be fetched, edited, or deleted individually.
    const id = "default:openai:gpt-5.6";
    const get = await callWorker(`${PRICES}/${id}`, { headers: authHeader(user.apiKey) });
    expect(get.status).toBe(404);
    const del = await callWorker(`${PRICES}/${id}`, { method: "DELETE", headers: authHeader(user.apiKey) });
    expect(del.status).toBe(404);
  });

  it("rejects a malformed active_on with 400", async () => {
    const res = await callWorker(`${PRICES}?active_on=not-a-date`, { headers: authHeader(user.apiKey) });
    expect(res.status).toBe(400);
  });
});

describe("GET /ai/prices/:id", () => {
  it("returns an owner row and a visible default row", async () => {
    const created = await callWorker(PRICES, {
      method: "POST",
      headers: jsonHeaders(user.apiKey),
      body: JSON.stringify(validPrice()),
    });
    const id = ((await created.json()) as { data: { id: string } }).data.id;

    const owner = await callWorker(`${PRICES}/${id}`, { headers: authHeader(user.apiKey) });
    expect(owner.status).toBe(200);

    await insertPrice({ id: "default-1", userId: user.userId, is_default: 1 });
    const def = await callWorker(`${PRICES}/default-1`, { headers: authHeader(user.apiKey) });
    expect(def.status).toBe(200);
    expect(((await def.json()) as { data: { is_default: boolean } }).data.is_default).toBe(true);
  });

  it("returns 404 for unknown and cross-user ids", async () => {
    await insertPrice({ id: "bob-row", userId: other.userId });
    expect((await callWorker(`${PRICES}/nope`, { headers: authHeader(user.apiKey) })).status).toBe(404);
    expect((await callWorker(`${PRICES}/bob-row`, { headers: authHeader(user.apiKey) })).status).toBe(404);
  });
});

describe("PATCH /ai/prices/:id", () => {
  async function createOwnerRow(): Promise<string> {
    const res = await callWorker(PRICES, {
      method: "POST",
      headers: jsonHeaders(user.apiKey),
      body: JSON.stringify(validPrice()),
    });
    return ((await res.json()) as { data: { id: string } }).data.id;
  }

  it("updates mutable fields and returns the new row", async () => {
    const id = await createOwnerRow();
    const res = await callWorker(`${PRICES}/${id}`, {
      method: "PATCH",
      headers: jsonHeaders(user.apiKey),
      body: JSON.stringify({ output_cost_per_mtok: 20, is_enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.output_cost_per_mtok).toBe(20);
    expect(body.data.is_enabled).toBe(false);
  });

  it.each([
    ["immutable provider", { provider: "x" }],
    ["immutable effective_from", { effective_from: "2026-05-01T00:00:00Z" }],
    ["empty body", {}],
    ["effective_to before effective_from", { effective_to: "2025-01-01T00:00:00Z" }],
  ])("rejects %s with 400", async (_label, patch) => {
    const id = await createOwnerRow();
    const res = await callWorker(`${PRICES}/${id}`, {
      method: "PATCH",
      headers: jsonHeaders(user.apiKey),
      body: JSON.stringify(patch),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a default row, unknown id, and cross-user row (before body validation)", async () => {
    await insertPrice({ id: "default-1", userId: user.userId, is_default: 1 });
    await insertPrice({ id: "bob-row", userId: other.userId });

    // A default row returns 404 even when the body itself is invalid (immutable
    // field), proving the ownership check precedes validation (FR-015).
    const def = await callWorker(`${PRICES}/default-1`, {
      method: "PATCH",
      headers: jsonHeaders(user.apiKey),
      body: JSON.stringify({ provider: "x" }),
    });
    expect(def.status).toBe(404);

    const unknown = await callWorker(`${PRICES}/nope`, {
      method: "PATCH",
      headers: jsonHeaders(user.apiKey),
      body: JSON.stringify({ output_cost_per_mtok: 1 }),
    });
    expect(unknown.status).toBe(404);

    const cross = await callWorker(`${PRICES}/bob-row`, {
      method: "PATCH",
      headers: jsonHeaders(user.apiKey),
      body: JSON.stringify({ output_cost_per_mtok: 1 }),
    });
    expect(cross.status).toBe(404);
  });
});

describe("DELETE /ai/prices/:id", () => {
  it("deletes an owner row (204) and it is then gone", async () => {
    const created = await callWorker(PRICES, {
      method: "POST",
      headers: jsonHeaders(user.apiKey),
      body: JSON.stringify(validPrice()),
    });
    const id = ((await created.json()) as { data: { id: string } }).data.id;

    const del = await callWorker(`${PRICES}/${id}`, { method: "DELETE", headers: authHeader(user.apiKey) });
    expect(del.status).toBe(204);

    const after = await callWorker(`${PRICES}/${id}`, { headers: authHeader(user.apiKey) });
    expect(after.status).toBe(404);
  });

  it("returns 404 for default rows, unknown ids, and cross-user rows", async () => {
    await insertPrice({ id: "default-1", userId: user.userId, is_default: 1 });
    await insertPrice({ id: "bob-row", userId: other.userId });

    expect((await callWorker(`${PRICES}/default-1`, { method: "DELETE", headers: authHeader(user.apiKey) })).status).toBe(404);
    expect((await callWorker(`${PRICES}/nope`, { method: "DELETE", headers: authHeader(user.apiKey) })).status).toBe(404);
    expect((await callWorker(`${PRICES}/bob-row`, { method: "DELETE", headers: authHeader(user.apiKey) })).status).toBe(404);

    // The default row survives the failed delete.
    expect((await callWorker(`${PRICES}/default-1`, { headers: authHeader(user.apiKey) })).status).toBe(200);
  });
});
