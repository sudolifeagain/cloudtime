/**
 * Unit tests for AI model-attribution detection (Issue #201, US1/US2).
 *
 * `detectUnattributedTools` is pure over an `AIUsageSummary`; only the `by_model`
 * groups matter, so each case crafts a minimal summary with a zeroed totals base.
 * The rollup coalesces a null `ai_model` to the literal `"unknown"` (the column is
 * `NOT NULL`), so the "unattributed" sentinel under test is the string `"unknown"`.
 */
import { describe, expect, it } from "vitest";
import { detectUnattributedTools } from "../../src/utils/ai/attribution";
import type { components } from "../../src/types/generated";

type AIUsageSummary = components["schemas"]["AIUsageSummary"];
type AITokenTotals = components["schemas"]["AITokenTotals"];

const ZERO_TOTALS: AITokenTotals = {
  input_tokens: 0,
  output_tokens: 0,
  cached_input_tokens: 0,
  reasoning_output_tokens: 0,
  cache_write_tokens: 0,
  cache_read_tokens: 0,
  prompt_length_total: 0,
  prompt_length_avg: null,
  heartbeat_count: 0,
  estimated_cost: null,
  missing_price_count: 0,
};

/** A minimal summary whose only meaningful content is its `by_model` groups. */
function summaryWith(
  byModel: Array<{ provider: string; model: string; heartbeat_count?: number }>,
): AIUsageSummary {
  return {
    start: "2026-07-01",
    end: "2026-07-30",
    timezone: "UTC",
    currency: "USD",
    totals: { ...ZERO_TOTALS },
    daily: [],
    by_project: [],
    by_agent: [],
    by_provider: [],
    by_model: byModel.map((m) => ({
      ...ZERO_TOTALS,
      provider: m.provider,
      model: m.model,
      heartbeat_count: m.heartbeat_count ?? 1,
    })),
  };
}

describe("detectUnattributedTools", () => {
  it("flags an openai/unknown group with tailored Codex guidance", () => {
    const status = detectUnattributedTools(
      summaryWith([{ provider: "openai", model: "unknown", heartbeat_count: 2 }]),
    );
    expect(status.hasUnattributed).toBe(true);
    expect(status.affected).toHaveLength(1);
    expect(status.affected[0]).toMatchObject({
      provider: "openai",
      tool: "Codex",
      heartbeatCount: 2,
      hasTailoredGuidance: true,
      command: "node scripts/patch-codex-wakatime.mjs",
    });
    expect(status.affected[0].docUrl).toContain("codex-model-attribution.md");
  });

  it("does not flag usage that already carries a concrete model", () => {
    const status = detectUnattributedTools(
      summaryWith([{ provider: "anthropic", model: "claude-opus-4-8", heartbeat_count: 5 }]),
    );
    expect(status.hasUnattributed).toBe(false);
    expect(status.affected).toEqual([]);
  });

  it("skips a group whose provider is itself unknown (nothing actionable to guide)", () => {
    const status = detectUnattributedTools(
      summaryWith([{ provider: "unknown", model: "unknown", heartbeat_count: 3 }]),
    );
    expect(status.hasUnattributed).toBe(false);
  });

  it("gives generic guidance (no command) for a recognized but unmapped provider", () => {
    const status = detectUnattributedTools(
      summaryWith([{ provider: "example-provider", model: "unknown", heartbeat_count: 4 }]),
    );
    expect(status.affected).toHaveLength(1);
    expect(status.affected[0]).toMatchObject({
      provider: "example-provider",
      tool: "example-provider",
      hasTailoredGuidance: false,
      command: null,
    });
    expect(status.affected[0].docUrl).toContain("ai-usage.md");
  });

  it("folds multiple same-provider unknown groups and sums their counts", () => {
    const status = detectUnattributedTools(
      summaryWith([
        { provider: "openai", model: "unknown", heartbeat_count: 2 },
        { provider: "openai", model: "unknown", heartbeat_count: 3 },
      ]),
    );
    expect(status.affected).toHaveLength(1);
    expect(status.affected[0].heartbeatCount).toBe(5);
  });

  it("ignores a zero-heartbeat unknown group alongside attributed usage", () => {
    const status = detectUnattributedTools(
      summaryWith([
        { provider: "openai", model: "gpt-5.6-sol", heartbeat_count: 10 },
        { provider: "openai", model: "unknown", heartbeat_count: 0 },
      ]),
    );
    expect(status.hasUnattributed).toBe(false);
  });

  it("sorts multiple affected providers by provider for a stable render", () => {
    const status = detectUnattributedTools(
      summaryWith([
        { provider: "openai", model: "unknown", heartbeat_count: 1 },
        { provider: "acme", model: "unknown", heartbeat_count: 1 },
      ]),
    );
    expect(status.affected.map((a) => a.provider)).toEqual(["acme", "openai"]);
  });

  it("returns nothing for an empty summary", () => {
    expect(detectUnattributedTools(summaryWith([])).hasUnattributed).toBe(false);
  });
});
