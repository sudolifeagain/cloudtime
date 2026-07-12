/**
 * Unit tests for the shipped default AI price catalog (src/utils/ai/default-prices.ts).
 * Pure: prices resolve by model-id shape (Anthropic by family, OpenAI per version)
 * and rank behind owner rows via the same selectEffectivePrice the cost path uses.
 */
import { describe, expect, it } from "vitest";
import { defaultPriceRows, resolveDefaultPrice } from "../../src/utils/ai/default-prices";
import { selectEffectivePrice } from "../../src/utils/ai/pricing";

describe("resolveDefaultPrice — Anthropic by family (new versions covered)", () => {
  it("prices any claude-opus version from the opus family rate", () => {
    for (const model of ["claude-opus-4-8", "claude-opus-4-9", "claude-opus-5-0"]) {
      expect(resolveDefaultPrice("u", "anthropic", model)).toMatchObject({
        provider: "anthropic",
        model,
        is_default: 1,
        is_enabled: 1,
        currency: "USD",
        input_cost_per_mtok: 5,
        output_cost_per_mtok: 25,
        cached_input_cost_per_mtok: 0.5,
        cache_write_cost_per_mtok: 6.25,
        cache_read_cost_per_mtok: 0.5,
      });
    }
  });

  it("prices the sonnet / haiku / fable / mythos families", () => {
    expect(resolveDefaultPrice("u", "anthropic", "claude-sonnet-5")).toMatchObject({ input_cost_per_mtok: 3, output_cost_per_mtok: 15 });
    expect(resolveDefaultPrice("u", "anthropic", "claude-haiku-4-5")).toMatchObject({ input_cost_per_mtok: 1, output_cost_per_mtok: 5 });
    expect(resolveDefaultPrice("u", "anthropic", "claude-fable-5")).toMatchObject({ input_cost_per_mtok: 10, output_cost_per_mtok: 50 });
    expect(resolveDefaultPrice("u", "anthropic", "claude-mythos-5")).toMatchObject({ input_cost_per_mtok: 10, output_cost_per_mtok: 50 });
  });

  it("returns null for an unknown Anthropic family or a non-claude id", () => {
    expect(resolveDefaultPrice("u", "anthropic", "claude-nova-1")).toBeNull();
    expect(resolveDefaultPrice("u", "anthropic", "not-a-claude-id")).toBeNull();
  });
});

describe("resolveDefaultPrice — OpenAI per version (incl. codex 5.6 tiers)", () => {
  it("prices the gpt-5.6 tiers and the bare slug", () => {
    expect(resolveDefaultPrice("u", "openai", "gpt-5.6")).toMatchObject({ input_cost_per_mtok: 5, output_cost_per_mtok: 30 });
    expect(resolveDefaultPrice("u", "openai", "gpt-5.6-sol")).toMatchObject({ input_cost_per_mtok: 5, output_cost_per_mtok: 30 });
    expect(resolveDefaultPrice("u", "openai", "gpt-5.6-terra")).toMatchObject({ input_cost_per_mtok: 2.5, output_cost_per_mtok: 15 });
    expect(resolveDefaultPrice("u", "openai", "gpt-5.6-luna")).toMatchObject({ input_cost_per_mtok: 1, output_cost_per_mtok: 6 });
  });

  it("prices gpt-5.5 and leaves OpenAI cache-write/read null (reported as cached_input)", () => {
    expect(resolveDefaultPrice("u", "openai", "gpt-5.5")).toMatchObject({
      input_cost_per_mtok: 5,
      output_cost_per_mtok: 30,
      cached_input_cost_per_mtok: 0.5,
      cache_write_cost_per_mtok: null,
      cache_read_cost_per_mtok: null,
    });
  });

  it("returns null for an OpenAI model not in the list (stays unpriced → missing_price_count)", () => {
    expect(resolveDefaultPrice("u", "openai", "gpt-5.7")).toBeNull();
    expect(resolveDefaultPrice("u", "openai", "o5")).toBeNull();
  });
});

describe("default price catalog — cross-cutting", () => {
  it("returns null for an unknown provider", () => {
    expect(resolveDefaultPrice("u", "acme", "whatever")).toBeNull();
  });

  it("bills reasoning output at the output rate and scopes the row to the user", () => {
    const r = resolveDefaultPrice("user-42", "anthropic", "claude-opus-4-8")!;
    expect(r.reasoning_output_cost_per_mtok).toBe(r.output_cost_per_mtok);
    expect(r.user_id).toBe("user-42");
    expect(r.id).toBe("default:anthropic:claude-opus-4-8");
    expect(r.effective_to).toBeNull();
  });

  it("lets an enabled owner row outrank the shipped default", () => {
    const dflt = resolveDefaultPrice("u", "openai", "gpt-5.5")!;
    const owner = { ...dflt, id: "owner-1", is_default: 0, input_cost_per_mtok: 99 };
    const picked = selectEffectivePrice([dflt, owner], Date.parse("2026-07-01T00:00:00Z"));
    expect(picked?.is_default).toBe(0);
    expect(picked?.id).toBe("owner-1");
  });
});

describe("defaultPriceRows — representative rows for the price list UI", () => {
  const rows = defaultPriceRows("u");

  it("lists Anthropic families as globs and OpenAI models explicitly", () => {
    const ids = rows.map((r) => `${r.provider}/${r.model}`);
    expect(ids).toContain("anthropic/claude-opus-*");
    expect(ids).toContain("anthropic/claude-sonnet-*");
    expect(ids).toContain("openai/gpt-5.6-luna");
    expect(ids).toContain("openai/gpt-5.5");
  });

  it("ships enabled, read-only rows with unique synthetic ids", () => {
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const r of rows) {
      expect(r.is_default).toBe(1);
      expect(r.is_enabled).toBe(1);
      expect(r.currency).toBe("USD");
    }
  });
});
