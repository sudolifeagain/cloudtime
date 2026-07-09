/**
 * AI usage rollup + summary-builder tests (Issue #200, US2).
 *
 * Covers three pure/aggregation concerns:
 *  - `computeAiDailyUsage`: contributing predicate (FR-026), own-time day key,
 *    provider/model/agent/project resolution, token sums, prompt-length avg.
 *  - `aggregateHeartbeats` against a real in-memory D1: the `ai_daily_usage`
 *    rollup is built from the same scan as `summaries`, prompt-length-only
 *    heartbeats create no bucket, and lookback rows are never double-counted.
 *  - `buildUsageSummary` / `resolveUsageRange`: aggregate-then-price cost,
 *    missing-price handling, single-currency selection + cross-currency
 *    exclusion, and deterministic range resolution (FR-008/FR-010/FR-022).
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateHeartbeats,
  computeAiDailyUsage,
  type AiHeartbeatForAggregation,
} from "../../src/cron/aggregate";
import {
  buildUsageSummary,
  resolveUsageRange,
  type AiDailyUsageRow,
} from "../../src/utils/ai/usage";
import type { AiModelPriceRow } from "../../src/utils/ai/pricing";
import { seedUser, truncate } from "../helpers/fixtures";

// ---------------------------------------------------------------------------
// computeAiDailyUsage (pure)
// ---------------------------------------------------------------------------

function hb(overrides: Partial<AiHeartbeatForAggregation> = {}): AiHeartbeatForAggregation {
  return {
    user_id: "u1",
    time: Date.UTC(2026, 2, 14, 10, 0, 0) / 1000,
    project: "cloudtime",
    language: null,
    editor: null,
    operating_system: null,
    category: "ai coding",
    branch: null,
    machine: null,
    user_agent_id: null,
    ai_provider: "anthropic",
    ai_model: "claude-opus-4",
    ai_prompt_length: null,
    ai_input_tokens: null,
    ai_output_tokens: null,
    ai_cached_input_tokens: null,
    ai_reasoning_output_tokens: null,
    ai_cache_write_tokens: null,
    ai_cache_read_tokens: null,
    ...overrides,
  };
}

const settings = new Map([["u1", { timeout: 900, timezone: "UTC" }]]);

describe("computeAiDailyUsage", () => {
  it("sums token classes and averages prompt length within a bucket", () => {
    const rollup = computeAiDailyUsage(
      [
        hb({ ai_input_tokens: 100, ai_output_tokens: 40, ai_prompt_length: 100 }),
        hb({ ai_input_tokens: 50, ai_output_tokens: 10, ai_prompt_length: 300 }),
      ],
      settings,
      new Map(),
    );
    expect(rollup.size).toBe(1);
    const t = [...rollup.values()][0];
    expect(t.day).toBe("2026-03-14");
    expect(t.provider).toBe("anthropic");
    expect(t.model).toBe("claude-opus-4");
    expect(t.agent).toBe("unknown");
    expect(t.project).toBe("cloudtime");
    expect(t.inputTokens).toBe(150);
    expect(t.outputTokens).toBe(50);
    expect(t.heartbeatCount).toBe(2);
    expect(t.promptLengthTotal).toBe(400);
    expect(t.promptLengthCount).toBe(2);
  });

  it("treats a present 0-value token field as contributing (FR-026)", () => {
    const rollup = computeAiDailyUsage([hb({ ai_input_tokens: 0 })], settings, new Map());
    expect(rollup.size).toBe(1);
    expect([...rollup.values()][0].heartbeatCount).toBe(1);
  });

  it("excludes prompt-length-only and non-ai-coding heartbeats", () => {
    const rollup = computeAiDailyUsage(
      [
        hb({ ai_prompt_length: 500 }), // no priced token field → not contributing
        hb({ category: "coding", ai_input_tokens: 100 }), // not ai coding
      ],
      settings,
      new Map(),
    );
    expect(rollup.size).toBe(0);
  });

  it("keys the day by the heartbeat's OWN time in the aggregation timezone", () => {
    const jst = new Map([["u1", { timeout: 900, timezone: "Asia/Tokyo" }]]);
    // 2026-03-14 20:00 UTC == 2026-03-15 05:00 JST
    const rollup = computeAiDailyUsage(
      [hb({ time: Date.UTC(2026, 2, 14, 20, 0, 0) / 1000, ai_input_tokens: 1 })],
      jst,
      new Map(),
    );
    expect([...rollup.values()][0].day).toBe("2026-03-15");
  });

  it("resolves agent from the user-agent label map, else unknown", () => {
    const rollup = computeAiDailyUsage(
      [
        hb({ user_agent_id: "ua1", ai_input_tokens: 1 }),
        hb({ user_agent_id: "missing", ai_input_tokens: 1 }),
      ],
      settings,
      new Map([["ua1", "vscode"]]),
    );
    const agents = [...rollup.values()].map((t) => t.agent).sort();
    expect(agents).toEqual(["unknown", "vscode"]);
  });

  it("falls back to unknown provider/model and the '' project sentinel", () => {
    const rollup = computeAiDailyUsage(
      [hb({ ai_provider: null, ai_model: null, project: null, ai_input_tokens: 1 })],
      settings,
      new Map(),
    );
    const t = [...rollup.values()][0];
    expect(t.provider).toBe("unknown");
    expect(t.model).toBe("unknown");
    expect(t.project).toBe("");
  });
});

// ---------------------------------------------------------------------------
// aggregateHeartbeats -> ai_daily_usage (integration)
// ---------------------------------------------------------------------------

async function seedAiHeartbeat(
  userId: string,
  time: number,
  fields: Partial<{
    category: string;
    project: string | null;
    user_agent_id: string | null;
    ai_provider: string | null;
    ai_model: string | null;
    ai_prompt_length: number | null;
    ai_input_tokens: number | null;
    ai_output_tokens: number | null;
  }> = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO heartbeats
       (id, user_id, entity, time, category, project, user_agent_id,
        ai_provider, ai_model, ai_prompt_length, ai_input_tokens, ai_output_tokens)
     VALUES (?, ?, 'src/x.ts', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      userId,
      time,
      fields.category ?? "ai coding",
      fields.project ?? "cloudtime",
      fields.user_agent_id ?? null,
      fields.ai_provider ?? "anthropic",
      fields.ai_model ?? "claude-opus-4",
      fields.ai_prompt_length ?? null,
      fields.ai_input_tokens ?? null,
      fields.ai_output_tokens ?? null,
    )
    .run();
}

async function usageRows(userId: string): Promise<AiDailyUsageRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT day, provider, model, agent, project, input_tokens, output_tokens,
            cached_input_tokens, reasoning_output_tokens, cache_write_tokens,
            cache_read_tokens, prompt_length_total, prompt_length_count, heartbeat_count
       FROM ai_daily_usage WHERE user_id = ? ORDER BY day, provider, model`,
  )
    .bind(userId)
    .all<AiDailyUsageRow>();
  return results;
}

describe("aggregateHeartbeats — ai_daily_usage rollup", () => {
  afterEach(async () => {
    await truncate("ai_daily_usage", "heartbeats", "user_agents", "summaries", "hourly_summaries", "meta", "users");
  });

  it("builds a rollup bucket with the resolved agent label", async () => {
    const user = await seedUser({ username: "roll", timezone: "UTC" });
    await env.DB.prepare(
      `INSERT INTO user_agents (id, user_id, value, editor) VALUES (?, ?, ?, ?)`,
    )
      .bind("ua-1", user.userId, "cloudtime/1.0", "vscode")
      .run();

    const base = Date.UTC(2026, 2, 14, 10, 0, 0) / 1000;
    await seedAiHeartbeat(user.userId, base, { user_agent_id: "ua-1", ai_input_tokens: 100, ai_output_tokens: 40, ai_prompt_length: 200 });
    await seedAiHeartbeat(user.userId, base + 60, { user_agent_id: "ua-1", ai_input_tokens: 50, ai_output_tokens: 10 });

    await aggregateHeartbeats(env.DB);

    const rows = await usageRows(user.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      day: "2026-03-14",
      provider: "anthropic",
      model: "claude-opus-4",
      agent: "vscode",
      project: "cloudtime",
      input_tokens: 150,
      output_tokens: 50,
      prompt_length_total: 200,
      prompt_length_count: 1,
      heartbeat_count: 2,
    });
  });

  it("does not create a bucket for a prompt-length-only heartbeat", async () => {
    const user = await seedUser({ username: "plonly", timezone: "UTC" });
    const base = Date.UTC(2026, 2, 14, 10, 0, 0) / 1000;
    await seedAiHeartbeat(user.userId, base, { ai_input_tokens: null, ai_output_tokens: null, ai_prompt_length: 500 });
    await aggregateHeartbeats(env.DB);
    expect(await usageRows(user.userId)).toHaveLength(0);
  });

  it("never re-counts lookback heartbeats across incremental runs", async () => {
    const user = await seedUser({ username: "look", timezone: "UTC" });
    const base = Date.UTC(2026, 2, 14, 10, 0, 0) / 1000;

    await seedAiHeartbeat(user.userId, base, { ai_input_tokens: 100 });
    await aggregateHeartbeats(env.DB); // watermark -> base

    // Second run: the first heartbeat is now a lookback row; only the new one is
    // summed, so the bucket totals each heartbeat exactly once.
    await seedAiHeartbeat(user.userId, base + 60, { ai_input_tokens: 50 });
    await aggregateHeartbeats(env.DB);

    const rows = await usageRows(user.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBe(150);
    expect(rows[0].heartbeat_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildUsageSummary / resolveUsageRange (pure)
// ---------------------------------------------------------------------------

function usageRow(overrides: Partial<AiDailyUsageRow> = {}): AiDailyUsageRow {
  return {
    day: "2026-03-14",
    provider: "openai",
    model: "gpt-4o",
    agent: "vscode",
    project: "cloudtime",
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    reasoning_output_tokens: 0,
    cache_write_tokens: 0,
    cache_read_tokens: 0,
    prompt_length_total: 0,
    prompt_length_count: 0,
    heartbeat_count: 1,
    ...overrides,
  };
}

function priceRow(overrides: Partial<AiModelPriceRow> = {}): AiModelPriceRow {
  return {
    id: crypto.randomUUID(),
    user_id: "u1",
    provider: "openai",
    model: "gpt-4o",
    currency: "USD",
    input_cost_per_mtok: null,
    cached_input_cost_per_mtok: null,
    output_cost_per_mtok: null,
    reasoning_output_cost_per_mtok: null,
    cache_write_cost_per_mtok: null,
    cache_read_cost_per_mtok: null,
    effective_from: "2026-01-01 00:00:00",
    effective_to: null,
    source_url: null,
    is_default: 0,
    is_enabled: 1,
    created_at: "2026-01-01 00:00:00",
    updated_at: "2026-01-01 00:00:00",
    ...overrides,
  };
}

const build = (rows: AiDailyUsageRow[], prices: AiModelPriceRow[]) =>
  buildUsageSummary({ start: "2026-03-01", end: "2026-03-31", timezone: "UTC", aggregationTz: "UTC", rows, prices });

describe("buildUsageSummary", () => {
  it("aggregate-then-prices a fully-covered bucket", () => {
    const s = build(
      [usageRow({ input_tokens: 1_000_000, output_tokens: 500_000 })],
      [priceRow({ input_cost_per_mtok: 2.5, output_cost_per_mtok: 10 })],
    );
    expect(s.currency).toBe("USD");
    expect(s.totals.estimated_cost).toBeCloseTo(7.5, 9); // 2.5 + 5
    expect(s.totals.missing_price_count).toBe(0);
    expect(s.mixed_currency).toBeUndefined();
    expect(s.by_model).toHaveLength(1);
    expect(s.by_model[0]).toMatchObject({ provider: "openai", model: "gpt-4o" });
  });

  it("counts a partial-rate bucket as missing (never a silent zero)", () => {
    const s = build(
      [usageRow({ input_tokens: 1_000_000, cache_read_tokens: 1000, heartbeat_count: 2 })],
      [priceRow({ input_cost_per_mtok: 2.5 })], // cache_read rate is null → partial
    );
    expect(s.totals.estimated_cost).toBeNull();
    expect(s.totals.missing_price_count).toBe(2);
  });

  it("returns null cost + missing_price_count when no price row matches", () => {
    const s = build([usageRow({ input_tokens: 100, heartbeat_count: 3 })], []);
    expect(s.currency).toBe("USD");
    expect(s.totals.estimated_cost).toBeNull();
    expect(s.totals.missing_price_count).toBe(3);
  });

  it("picks one currency by contributing heartbeats and excludes the rest", () => {
    const rows = [
      usageRow({ provider: "openai", model: "gpt-4o", input_tokens: 1_000_000, heartbeat_count: 3 }),
      usageRow({ provider: "anthropic", model: "claude", input_tokens: 1_000_000, heartbeat_count: 1 }),
    ];
    const prices = [
      priceRow({ provider: "openai", model: "gpt-4o", currency: "USD", input_cost_per_mtok: 2 }),
      priceRow({ provider: "anthropic", model: "claude", currency: "EUR", input_cost_per_mtok: 3 }),
    ];
    const s = build(rows, prices);
    expect(s.currency).toBe("USD"); // 3 heartbeats vs 1
    expect(s.mixed_currency).toBe(true);
    expect(s.totals.estimated_cost).toBeCloseTo(2, 9); // only the USD bucket
    expect(s.totals.missing_price_count).toBe(1); // the EUR bucket's heartbeat
  });

  it("breaks a currency tie by smallest ISO code", () => {
    const rows = [
      usageRow({ provider: "openai", model: "gpt-4o", input_tokens: 1_000_000, heartbeat_count: 2 }),
      usageRow({ provider: "anthropic", model: "claude", input_tokens: 1_000_000, heartbeat_count: 2 }),
    ];
    const prices = [
      priceRow({ provider: "openai", model: "gpt-4o", currency: "USD", input_cost_per_mtok: 2 }),
      priceRow({ provider: "anthropic", model: "claude", currency: "EUR", input_cost_per_mtok: 3 }),
    ];
    expect(build(rows, prices).currency).toBe("EUR");
  });

  it("computes prompt_length_avg and groups by every dimension", () => {
    const s = build(
      [
        usageRow({ project: "a", input_tokens: 1, prompt_length_total: 300, prompt_length_count: 2, heartbeat_count: 2 }),
        usageRow({ project: null as unknown as string, input_tokens: 1, heartbeat_count: 1 }),
      ],
      [],
    );
    expect(s.totals.prompt_length_avg).toBeCloseTo(150, 9); // 300 / 2
    expect(s.daily).toHaveLength(1);
    const projects = s.by_project.map((p) => p.project).sort();
    expect(projects).toEqual(["a", null]);
  });
});

describe("resolveUsageRange", () => {
  it("accepts an explicit inclusive range and ignores days", () => {
    const r = resolveUsageRange("2026-03-01", "2026-03-10", "5", "UTC");
    expect(r).toEqual({ ok: true, start: "2026-03-01", end: "2026-03-10" });
  });

  it("rejects exactly one of start/end", () => {
    expect(resolveUsageRange("2026-03-01", undefined, undefined, "UTC").ok).toBe(false);
    expect(resolveUsageRange(undefined, "2026-03-10", undefined, "UTC").ok).toBe(false);
  });

  it("rejects start after end and spans over 366 days", () => {
    expect(resolveUsageRange("2026-03-10", "2026-03-01", undefined, "UTC").ok).toBe(false);
    expect(resolveUsageRange("2025-01-01", "2026-01-02", undefined, "UTC").ok).toBe(false);
  });

  it("rejects invalid dates and out-of-range days", () => {
    expect(resolveUsageRange("2026-13-01", "2026-13-02", undefined, "UTC").ok).toBe(false);
    expect(resolveUsageRange(undefined, undefined, "0", "UTC").ok).toBe(false);
    expect(resolveUsageRange(undefined, undefined, "400", "UTC").ok).toBe(false);
    expect(resolveUsageRange(undefined, undefined, "abc", "UTC").ok).toBe(false);
  });

  it("defaults to a trailing 30-day window", () => {
    const r = resolveUsageRange(undefined, undefined, undefined, "UTC");
    expect(r.ok).toBe(true);
    if (r.ok) {
      const span =
        (new Date(r.end + "T00:00:00Z").getTime() - new Date(r.start + "T00:00:00Z").getTime()) /
          86_400_000 +
        1;
      expect(span).toBe(30);
    }
  });
});
