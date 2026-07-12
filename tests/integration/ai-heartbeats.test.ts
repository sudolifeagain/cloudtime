/**
 * Integration tests for AI telemetry ingestion (Issue #200, US1).
 *
 * Covers single + bulk ingestion of the AI token/session/provider fields, the
 * GET /heartbeats round-trip, backward compatibility when the fields are
 * omitted, and 400 rejection of malformed token values. Uses a real in-memory
 * D1 (vitest-pool-workers) and authenticates via API key bearer auth.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { seedUser, truncate, type SeededUser } from "../helpers/fixtures";

let user: SeededUser;

beforeEach(async () => {
  user = await seedUser({ username: "alice", timezone: "UTC" });
});

afterEach(async () => {
  await truncate("heartbeats", "user_projects", "user_agents", "users");
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

/** A representative AI-coding heartbeat with every telemetry field populated. */
function aiHeartbeat(overrides: Record<string, unknown> = {}) {
  return {
    entity: "src/index.ts",
    type: "file",
    time: TIME_2026_03_14_10_00_UTC,
    category: "ai coding",
    project: "cloudtime",
    ai_session: "sess-abc123",
    ai_subscription_plan: "pro",
    ai_prompt_length: 4096,
    ai_input_tokens: 1500,
    ai_output_tokens: 800,
    ai_cached_input_tokens: 300,
    ai_reasoning_output_tokens: 250,
    ai_cache_write_tokens: 120,
    ai_cache_read_tokens: 90,
    ai_provider: "anthropic",
    ai_model: "claude-opus-4",
    ...overrides,
  };
}

describe("POST /heartbeats — AI telemetry (single)", () => {
  it("stores and echoes AI telemetry fields with 201", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(user.apiKey) },
      body: JSON.stringify(aiHeartbeat()),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.ai_session).toBe("sess-abc123");
    expect(body.data.ai_subscription_plan).toBe("pro");
    expect(body.data.ai_input_tokens).toBe(1500);
    expect(body.data.ai_output_tokens).toBe(800);
    expect(body.data.ai_cached_input_tokens).toBe(300);
    expect(body.data.ai_reasoning_output_tokens).toBe(250);
    expect(body.data.ai_cache_write_tokens).toBe(120);
    expect(body.data.ai_cache_read_tokens).toBe(90);
    expect(body.data.ai_prompt_length).toBe(4096);
    expect(body.data.ai_provider).toBe("anthropic");
    expect(body.data.ai_model).toBe("claude-opus-4");
  });

  it("round-trips AI telemetry through GET /heartbeats", async () => {
    const post = await callWorker("/api/v1/users/current/heartbeats", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(user.apiKey) },
      body: JSON.stringify(aiHeartbeat()),
    });
    expect(post.status).toBe(201);

    const res = await callWorker("/api/v1/users/current/heartbeats?date=2026-03-14", {
      headers: authHeader(user.apiKey),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    expect(body.data).toHaveLength(1);
    const hb = body.data[0];
    expect(hb.ai_input_tokens).toBe(1500);
    expect(hb.ai_output_tokens).toBe(800);
    expect(hb.ai_cached_input_tokens).toBe(300);
    expect(hb.ai_reasoning_output_tokens).toBe(250);
    expect(hb.ai_cache_write_tokens).toBe(120);
    expect(hb.ai_cache_read_tokens).toBe(90);
    expect(hb.ai_prompt_length).toBe(4096);
    expect(hb.ai_session).toBe("sess-abc123");
    expect(hb.ai_subscription_plan).toBe("pro");
    expect(hb.ai_provider).toBe("anthropic");
    expect(hb.ai_model).toBe("claude-opus-4");
  });

  it("accepts a heartbeat with no AI fields (backward compatible)", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(user.apiKey) },
      body: JSON.stringify({ entity: "plain.ts", type: "file", time: TIME_2026_03_14_10_00_UTC }),
    });
    expect(res.status).toBe(201);

    const res2 = await callWorker("/api/v1/users/current/heartbeats?date=2026-03-14", {
      headers: authHeader(user.apiKey),
    });
    const body = (await res2.json()) as { data: Record<string, unknown>[] };
    expect(body.data).toHaveLength(1);
    // Omitted AI fields are stored as SQL NULL and surface as null on read.
    expect(body.data[0].ai_input_tokens).toBeNull();
    expect(body.data[0].ai_provider).toBeNull();
  });

  it("accepts a zero token value (presence, not truthiness)", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(user.apiKey) },
      body: JSON.stringify(aiHeartbeat({ ai_input_tokens: 0 })),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.ai_input_tokens).toBe(0);
  });

  it("accepts the maximum token value (1e9)", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(user.apiKey) },
      body: JSON.stringify(aiHeartbeat({ ai_input_tokens: 1_000_000_000 })),
    });
    expect(res.status).toBe(201);
  });

  it.each([
    ["negative", { ai_input_tokens: -1 }],
    ["non-integer float", { ai_output_tokens: 12.5 }],
    ["above the 1e9 cap", { ai_cached_input_tokens: 1_000_000_001 }],
    ["a string", { ai_reasoning_output_tokens: "lots" }],
    ["negative prompt length", { ai_prompt_length: -5 }],
  ])("rejects a malformed token value (%s) with 400", async (_label, bad) => {
    const res = await callWorker("/api/v1/users/current/heartbeats", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(user.apiKey) },
      body: JSON.stringify(aiHeartbeat(bad)),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("rejects an over-long ai_provider with 400", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(user.apiKey) },
      body: JSON.stringify(aiHeartbeat({ ai_provider: "x".repeat(256) })),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ai_provider must be at most 255 characters");
  });
});

describe("POST /heartbeats.bulk — AI telemetry", () => {
  it("stores AI telemetry for every item in a bulk batch", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats.bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(user.apiKey) },
      body: JSON.stringify([
        aiHeartbeat({ ai_input_tokens: 100 }),
        aiHeartbeat({ entity: "b.ts", ai_input_tokens: 200, ai_output_tokens: 50 }),
      ]),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { responses: [Record<string, unknown>, number][] };
    expect(body.responses).toHaveLength(2);
    expect(body.responses[0][1]).toBe(201);
    expect(body.responses[1][1]).toBe(201);

    // Confirm both rows persisted with their AI token sums intact.
    const get = await callWorker("/api/v1/users/current/heartbeats?date=2026-03-14", {
      headers: authHeader(user.apiKey),
    });
    const data = ((await get.json()) as { data: Record<string, number>[] }).data;
    expect(data).toHaveLength(2);
    const inputs = data.map((h) => h.ai_input_tokens).sort((a, b) => a - b);
    expect(inputs).toEqual([100, 200]);
  });

  it("reports a per-item 400 for a malformed token value without failing the batch", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats.bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(user.apiKey) },
      body: JSON.stringify([
        aiHeartbeat({ ai_input_tokens: 100 }),
        aiHeartbeat({ entity: "bad.ts", ai_input_tokens: -1 }),
        aiHeartbeat({ entity: "c.ts", ai_input_tokens: 300 }),
      ]),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { responses: [Record<string, unknown>, number][] };
    expect(body.responses[0][1]).toBe(201);
    expect(body.responses[1][1]).toBe(400);
    expect(body.responses[1][0].error).toBeTruthy();
    expect(body.responses[2][1]).toBe(201);

    // Only the two valid heartbeats should have persisted.
    const get = await callWorker("/api/v1/users/current/heartbeats?date=2026-03-14", {
      headers: authHeader(user.apiKey),
    });
    const data = ((await get.json()) as { data: unknown[] }).data;
    expect(data).toHaveLength(2);
  });
});

describe("AI provider/model derived from the User-Agent (Issue #200)", () => {
  // Real compatible AI-plugin User-Agents observed in production: the model
  // lives in the UA (`opus/4-8`), not the heartbeat body.
  const CLAUDE_UA =
    "wakatime/v2.22.0 (windows-10.0.26200.8655-x86_64) go1.26.5 opus/4-8 claude-code/2.1.205 claude-code-wakatime/4.1.0";
  const CODEX_UA =
    "wakatime/v2.22.0 (windows-10.0.26200.8655-x86_64) go1.26.5 opus/4-8 claude-code/2.1.205 codex-cli/unknown codex-cli-wakatime/1.0.0";

  async function firstStored(): Promise<Record<string, unknown>> {
    const get = await callWorker("/api/v1/users/current/heartbeats?date=2026-03-14", {
      headers: authHeader(user.apiKey),
    });
    return ((await get.json()) as { data: Record<string, unknown>[] }).data[0];
  }

  it("fills ai_provider/ai_model from a Claude Code UA when the client omits them", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": CLAUDE_UA, ...authHeader(user.apiKey) },
      body: JSON.stringify(aiHeartbeat({ ai_provider: undefined, ai_model: undefined })),
    });
    expect(res.status).toBe(201);

    const hb = await firstStored();
    expect(hb.ai_provider).toBe("anthropic");
    expect(hb.ai_model).toBe("claude-opus-4-8");
  });

  it("attributes a codex heartbeat to openai without cross-attributing the claude model", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": CODEX_UA, ...authHeader(user.apiKey) },
      body: JSON.stringify(aiHeartbeat({ ai_provider: undefined, ai_model: undefined })),
    });
    expect(res.status).toBe(201);

    const hb = await firstStored();
    expect(hb.ai_provider).toBe("openai");
    expect(hb.ai_model).toBeNull();
  });

  it("never overrides an explicit ai_provider/ai_model sent by the client", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": CLAUDE_UA, ...authHeader(user.apiKey) },
      body: JSON.stringify(aiHeartbeat({ ai_provider: "anthropic", ai_model: "claude-sonnet-5" })),
    });
    expect(res.status).toBe(201);

    const hb = await firstStored();
    expect(hb.ai_model).toBe("claude-sonnet-5");
  });

  it("does not cross-attribute a derived model when the client pins only the provider", async () => {
    // Client sent an explicit provider but no model, alongside a Claude Code UA
    // carrying `opus/4-8`. Deriving only the missing model would attach the
    // co-running Claude model to the client's provider — derivation is
    // all-or-nothing, so the explicit provider wins and the model stays null.
    const res = await callWorker("/api/v1/users/current/heartbeats", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": CLAUDE_UA, ...authHeader(user.apiKey) },
      body: JSON.stringify(aiHeartbeat({ ai_provider: "openai", ai_model: undefined })),
    });
    expect(res.status).toBe(201);

    const hb = await firstStored();
    expect(hb.ai_provider).toBe("openai");
    expect(hb.ai_model).toBeNull();
  });

  it("does not derive for a non-`ai coding` heartbeat", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": CLAUDE_UA, ...authHeader(user.apiKey) },
      body: JSON.stringify(aiHeartbeat({ category: "coding", ai_provider: undefined, ai_model: undefined })),
    });
    expect(res.status).toBe(201);

    const hb = await firstStored();
    expect(hb.ai_provider).toBeNull();
    expect(hb.ai_model).toBeNull();
  });

  it("derives per item in a bulk batch from each item's own User-Agent", async () => {
    const res = await callWorker("/api/v1/users/current/heartbeats.bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader(user.apiKey) },
      body: JSON.stringify([
        aiHeartbeat({ entity: "a.ts", user_agent: CLAUDE_UA, ai_provider: undefined, ai_model: undefined }),
        aiHeartbeat({ entity: "b.ts", user_agent: CODEX_UA, ai_provider: undefined, ai_model: undefined }),
      ]),
    });
    expect(res.status).toBe(202);

    const get = await callWorker("/api/v1/users/current/heartbeats?date=2026-03-14", {
      headers: authHeader(user.apiKey),
    });
    const data = ((await get.json()) as { data: Record<string, unknown>[] }).data;
    const byEntity = Object.fromEntries(data.map((h) => [h.entity, h]));
    expect(byEntity["a.ts"].ai_provider).toBe("anthropic");
    expect(byEntity["a.ts"].ai_model).toBe("claude-opus-4-8");
    expect(byEntity["b.ts"].ai_provider).toBe("openai");
    expect(byEntity["b.ts"].ai_model).toBeNull();
  });
});
