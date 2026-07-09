/**
 * Unit tests for AI price selection + validation (Issue #200, US3 / T108).
 *
 * Pure logic — no D1. Covers `selectEffectivePrice` (window matching,
 * owner-over-default precedence FR-021, latest-effective_from tie-break,
 * exclusive upper bound, open-ended windows), `windowsOverlap`, and the
 * create/update body validators.
 */
import { describe, expect, it } from "vitest";
import {
  selectEffectivePrice,
  windowsOverlap,
  validateCreatePrice,
  validateUpdatePrice,
} from "../../src/utils/ai/pricing";

interface Row {
  id: string;
  is_default: number;
  effective_from: string;
  effective_to: string | null;
}

function row(id: string, is_default: number, from: string, to: string | null): Row {
  return { id, is_default, effective_from: from, effective_to: to };
}

describe("selectEffectivePrice", () => {
  it("returns the row whose window contains the instant", () => {
    const rows = [
      row("a", 0, "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"),
      row("b", 0, "2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"),
    ];
    expect(selectEffectivePrice(rows, "2026-01-15T12:00:00Z")?.id).toBe("a");
    expect(selectEffectivePrice(rows, "2026-02-15T12:00:00Z")?.id).toBe("b");
  });

  it("returns null when no window contains the instant", () => {
    const rows = [row("a", 0, "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z")];
    expect(selectEffectivePrice(rows, "2025-12-31T23:59:59Z")).toBeNull();
    expect(selectEffectivePrice(rows, "2026-03-01T00:00:00Z")).toBeNull();
  });

  it("treats effective_to as exclusive (at === effective_to does not match)", () => {
    const rows = [row("a", 0, "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z")];
    expect(selectEffectivePrice(rows, "2026-02-01T00:00:00Z")).toBeNull();
  });

  it("matches an open-ended (null effective_to) window for any future instant", () => {
    const rows = [row("a", 0, "2026-01-01T00:00:00Z", null)];
    expect(selectEffectivePrice(rows, "2030-06-01T00:00:00Z")?.id).toBe("a");
  });

  it("prefers an owner row over a default row when both match (FR-021)", () => {
    const rows = [
      row("default", 1, "2026-01-01T00:00:00Z", null),
      row("owner", 0, "2026-01-01T00:00:00Z", null),
    ];
    expect(selectEffectivePrice(rows, "2026-06-01T00:00:00Z")?.id).toBe("owner");
  });

  it("prefers the latest effective_from within the same class", () => {
    const rows = [
      row("older", 0, "2026-01-01T00:00:00Z", null),
      row("newer", 0, "2026-03-01T00:00:00Z", null),
    ];
    expect(selectEffectivePrice(rows, "2026-06-01T00:00:00Z")?.id).toBe("newer");
  });

  it("accepts an epoch-ms instant", () => {
    const rows = [row("a", 0, "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z")];
    const at = Date.parse("2026-01-15T00:00:00Z");
    expect(selectEffectivePrice(rows, at)?.id).toBe("a");
  });
});

describe("windowsOverlap", () => {
  it("detects overlapping windows", () => {
    expect(
      windowsOverlap(
        "2026-01-01T00:00:00Z",
        "2026-02-01T00:00:00Z",
        "2026-01-15T00:00:00Z",
        "2026-03-01T00:00:00Z",
      ),
    ).toBe(true);
  });

  it("treats adjacent windows (aTo === bFrom) as non-overlapping", () => {
    expect(
      windowsOverlap(
        "2026-01-01T00:00:00Z",
        "2026-02-01T00:00:00Z",
        "2026-02-01T00:00:00Z",
        "2026-03-01T00:00:00Z",
      ),
    ).toBe(false);
  });

  it("returns false for disjoint windows", () => {
    expect(
      windowsOverlap(
        "2026-01-01T00:00:00Z",
        "2026-02-01T00:00:00Z",
        "2026-05-01T00:00:00Z",
        "2026-06-01T00:00:00Z",
      ),
    ).toBe(false);
  });

  it("treats a null effective_to as open-ended", () => {
    expect(
      windowsOverlap("2026-01-01T00:00:00Z", null, "2030-01-01T00:00:00Z", null),
    ).toBe(true);
  });
});

describe("validateCreatePrice", () => {
  const base = {
    provider: "openai",
    model: "gpt-4o",
    effective_from: "2026-01-01T00:00:00Z",
    input_cost_per_mtok: 2.5,
  };

  it("accepts a minimal valid body and applies defaults", () => {
    const res = validateCreatePrice(base);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.currency).toBe("USD");
    expect(res.value.is_enabled).toBe(true);
    expect(res.value.effective_to).toBeNull();
    expect(res.value.rates.input_cost_per_mtok).toBe(2.5);
    // effective_from normalised to the SQLite datetime format (UTC, no millis).
    expect(res.value.effective_from).toBe("2026-01-01 00:00:00");
  });

  it("accepts a zero rate (presence, not truthiness)", () => {
    const res = validateCreatePrice({ ...base, input_cost_per_mtok: 0 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.rates.input_cost_per_mtok).toBe(0);
  });

  it.each([
    ["missing provider", { model: "m", effective_from: "2026-01-01T00:00:00Z", input_cost_per_mtok: 1 }],
    ["missing model", { provider: "p", effective_from: "2026-01-01T00:00:00Z", input_cost_per_mtok: 1 }],
    ["missing effective_from", { provider: "p", model: "m", input_cost_per_mtok: 1 }],
    ["invalid effective_from", { provider: "p", model: "m", effective_from: "nope", input_cost_per_mtok: 1 }],
    ["no rate field", { provider: "p", model: "m", effective_from: "2026-01-01T00:00:00Z" }],
    ["negative rate", { ...base, input_cost_per_mtok: -1 }],
    ["rate above 1e6", { ...base, input_cost_per_mtok: 1_000_001 }],
    ["lower-case currency", { ...base, currency: "usd" }],
    ["non-http source_url", { ...base, source_url: "javascript:alert(1)" }],
    ["effective_to not after from", { ...base, effective_to: "2026-01-01T00:00:00Z" }],
    ["effective_to before from", { ...base, effective_to: "2025-12-01T00:00:00Z" }],
    ["is_enabled not boolean", { ...base, is_enabled: "yes" }],
  ])("rejects %s with an error", (_label, body) => {
    const res = validateCreatePrice(body);
    expect(res.ok).toBe(false);
  });

  it("accepts an effective_to strictly after effective_from", () => {
    const res = validateCreatePrice({ ...base, effective_to: "2026-02-01T00:00:00Z" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.effective_to).toBe("2026-02-01 00:00:00");
  });
});

describe("validateUpdatePrice", () => {
  it.each([
    ["provider", { provider: "x" }],
    ["model", { model: "y" }],
    ["effective_from", { effective_from: "2026-01-01T00:00:00Z" }],
  ])("rejects an immutable field (%s)", (_label, body) => {
    const res = validateUpdatePrice(body);
    expect(res.ok).toBe(false);
  });

  it("rejects an empty body", () => {
    expect(validateUpdatePrice({}).ok).toBe(false);
  });

  it("collects a currency + rate update", () => {
    const res = validateUpdatePrice({ currency: "EUR", output_cost_per_mtok: 10 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.columns).toContain("currency");
    expect(res.value.columns).toContain("output_cost_per_mtok");
  });

  it("records is_enabled as a 0/1 value and flags it for the overlap re-check", () => {
    const res = validateUpdatePrice({ is_enabled: false });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.isEnabledProvided).toBe(true);
    expect(res.value.isEnabled).toBe(false);
    const idx = res.value.columns.indexOf("is_enabled");
    expect(res.value.values[idx]).toBe(0);
  });

  it("treats an explicit effective_to: null as provided (open-ended)", () => {
    const res = validateUpdatePrice({ effective_to: null });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.effectiveToProvided).toBe(true);
    expect(res.value.effectiveTo).toBeNull();
  });

  it("rejects a malformed rate", () => {
    expect(validateUpdatePrice({ input_cost_per_mtok: -5 }).ok).toBe(false);
  });
});
