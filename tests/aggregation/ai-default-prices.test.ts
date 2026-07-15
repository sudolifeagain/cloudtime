/**
 * Unit tests for the shipped default AI price catalog (src/utils/ai/default-prices.ts).
 * Pure: prices resolve by model-id shape (Anthropic by family, OpenAI per version),
 * carry time windows when a list rate changes on a known date, and rank behind
 * owner rows via the same selectEffectivePrice the cost path uses.
 */
import { describe, expect, it } from "vitest";
import {
  defaultPriceRows,
  resolveDefaultPrices,
  resolveUsageDefaultPrices,
} from "../../src/utils/ai/default-prices";
import { selectEffectivePrice } from "../../src/utils/ai/pricing";

describe("resolveDefaultPrices — Anthropic by family (new versions covered)", () => {
  it("prices any claude-opus version from the opus family rate", () => {
    for (const model of ["claude-opus-4-8", "claude-opus-4-9", "claude-opus-5-0"]) {
      const rows = resolveDefaultPrices("u", "anthropic", model);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
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
        effective_to: null,
      });
    }
  });

  it("prices the haiku / fable / mythos families as a single open-ended window", () => {
    expect(resolveDefaultPrices("u", "anthropic", "claude-haiku-4-5")).toMatchObject([
      { input_cost_per_mtok: 1, output_cost_per_mtok: 5, effective_to: null },
    ]);
    expect(resolveDefaultPrices("u", "anthropic", "claude-fable-5")).toMatchObject([
      { input_cost_per_mtok: 10, output_cost_per_mtok: 50, effective_to: null },
    ]);
    expect(resolveDefaultPrices("u", "anthropic", "claude-mythos-5")).toMatchObject([
      { input_cost_per_mtok: 10, output_cost_per_mtok: 50, effective_to: null },
    ]);
  });

  it("prices sonnet as two windows: introductory $2/$10 through 2026-08-31, then $3/$15", () => {
    const rows = resolveDefaultPrices("u", "anthropic", "claude-sonnet-5");
    expect(rows).toHaveLength(2);
    // Two enabled windows must not overlap and must carry unique synthetic ids.
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    // Effective-row selection prices each usage day from the right window.
    const intro = selectEffectivePrice(rows, Date.parse("2026-07-15T00:00:00Z"));
    const standard = selectEffectivePrice(rows, Date.parse("2026-09-15T00:00:00Z"));
    expect(intro).toMatchObject({ input_cost_per_mtok: 2, output_cost_per_mtok: 10 });
    expect(standard).toMatchObject({ input_cost_per_mtok: 3, output_cost_per_mtok: 15 });
  });

  it("returns an empty array for an unknown Anthropic family or a non-claude id", () => {
    expect(resolveDefaultPrices("u", "anthropic", "claude-nova-1")).toEqual([]);
    expect(resolveDefaultPrices("u", "anthropic", "not-a-claude-id")).toEqual([]);
  });
});

describe("resolveDefaultPrices — OpenAI per version (incl. codex 5.6 tiers)", () => {
  it("prices the gpt-5.6 tiers and the bare slug", () => {
    expect(resolveDefaultPrices("u", "openai", "gpt-5.6")[0]).toMatchObject({ input_cost_per_mtok: 5, output_cost_per_mtok: 30 });
    expect(resolveDefaultPrices("u", "openai", "gpt-5.6-sol")[0]).toMatchObject({ input_cost_per_mtok: 5, output_cost_per_mtok: 30 });
    expect(resolveDefaultPrices("u", "openai", "gpt-5.6-terra")[0]).toMatchObject({ input_cost_per_mtok: 2.5, output_cost_per_mtok: 15 });
    expect(resolveDefaultPrices("u", "openai", "gpt-5.6-luna")[0]).toMatchObject({ input_cost_per_mtok: 1, output_cost_per_mtok: 6 });
  });

  it("bills gpt-5.6+ cache writes at 1.25x input, cache-read null (reported as cached_input)", () => {
    expect(resolveDefaultPrices("u", "openai", "gpt-5.6-sol")[0]).toMatchObject({
      cached_input_cost_per_mtok: 0.5,
      cache_write_cost_per_mtok: 6.25,
      cache_read_cost_per_mtok: null,
    });
    expect(resolveDefaultPrices("u", "openai", "gpt-5.6-luna")[0]).toMatchObject({
      cache_write_cost_per_mtok: 1.25,
      cache_read_cost_per_mtok: null,
    });
  });

  it("leaves pre-5.6 OpenAI cache-write null (gpt-5.5)", () => {
    expect(resolveDefaultPrices("u", "openai", "gpt-5.5")[0]).toMatchObject({
      input_cost_per_mtok: 5,
      output_cost_per_mtok: 30,
      cached_input_cost_per_mtok: 0.5,
      cache_write_cost_per_mtok: null,
      cache_read_cost_per_mtok: null,
    });
  });

  it("returns an empty array for an OpenAI model not in the list (stays unpriced → missing_price_count)", () => {
    expect(resolveDefaultPrices("u", "openai", "gpt-5.7")).toEqual([]);
    expect(resolveDefaultPrices("u", "openai", "o5")).toEqual([]);
  });
});

describe("default price catalog — cross-cutting", () => {
  it("returns an empty array for an unknown provider", () => {
    expect(resolveDefaultPrices("u", "acme", "whatever")).toEqual([]);
  });

  it("bills reasoning output at the output rate and scopes the row to the user", () => {
    const r = resolveDefaultPrices("user-42", "anthropic", "claude-opus-4-8")[0];
    expect(r.reasoning_output_cost_per_mtok).toBe(r.output_cost_per_mtok);
    expect(r.user_id).toBe("user-42");
    expect(r.id).toBe("default:anthropic:claude-opus-4-8");
    expect(r.effective_to).toBeNull();
  });

  it("lets an enabled owner row outrank the shipped default", () => {
    const dflt = resolveDefaultPrices("u", "openai", "gpt-5.5")[0];
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

  it("ships enabled, read-only rows with unique synthetic ids (incl. sonnet's two windows)", () => {
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    // Sonnet contributes one glob row per time window.
    expect(rows.filter((r) => r.model === "claude-sonnet-*")).toHaveLength(2);
    for (const r of rows) {
      expect(r.is_default).toBe(1);
      expect(r.is_enabled).toBe(1);
      expect(r.currency).toBe("USD");
    }
  });
});

describe("resolveUsageDefaultPrices — shared default resolution for used rollup rows", () => {
  it("resolves one default set per distinct (provider, model), deduplicated", () => {
    // Duplicate anthropic pair + a two-window sonnet + a priced OpenAI model.
    const usage = [
      { provider: "anthropic", model: "claude-opus-4-8" },
      { provider: "anthropic", model: "claude-opus-4-8" },
      { provider: "anthropic", model: "claude-sonnet-5" },
      { provider: "openai", model: "gpt-5.5" },
    ];
    const out = resolveUsageDefaultPrices("u", usage);
    // opus (1 window, once despite the dup) + sonnet (2 windows) + gpt-5.5 (1) = 4.
    expect(out).toHaveLength(4);
    expect(out.filter((r) => r.model === "claude-opus-4-8")).toHaveLength(1);
    expect(out.filter((r) => r.model === "claude-sonnet-5")).toHaveLength(2);
    expect(out.filter((r) => r.model === "gpt-5.5")).toHaveLength(1);
    for (const r of out) expect(r.user_id).toBe("u");
  });

  it("covers a claude version with no explicit list entry via its family", () => {
    // A future opus version the catalog never enumerated still prices from opus.
    const out = resolveUsageDefaultPrices("u", [{ provider: "anthropic", model: "claude-opus-9-9" }]);
    expect(out).toMatchObject([{ input_cost_per_mtok: 5, output_cost_per_mtok: 25 }]);
  });

  it("omits models with no shipped default (they stay unpriced → missing_price_count)", () => {
    const out = resolveUsageDefaultPrices("u", [
      { provider: "openai", model: "unknown" },
      { provider: "anthropic", model: "claude-nova-1" },
      { provider: "openai", model: "gpt-5.5" },
    ]);
    // Only gpt-5.5 resolves; the unpriced pairs contribute nothing.
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ provider: "openai", model: "gpt-5.5" });
  });

  it("returns an empty array for empty usage", () => {
    expect(resolveUsageDefaultPrices("u", [])).toEqual([]);
  });
});
