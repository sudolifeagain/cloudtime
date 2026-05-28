/**
 * Unit tests for src/utils/custom-rules.ts (pure matcher) and
 * src/utils/custom-rule-input.ts (PUT validation). No D1, no KV.
 */
import { describe, expect, it } from "vitest";
import { applyRules, type CompiledRule } from "../../src/utils/custom-rules";
import { validateCustomRules, MAX_RULES } from "../../src/utils/custom-rule-input";

function rule(partial: Partial<CompiledRule>): CompiledRule {
  return {
    action: "change",
    source: "project",
    operation: "equals",
    source_value: "old",
    destination: "project",
    destination_value: "new",
    ...partial,
  };
}

describe("applyRules (matcher)", () => {
  it("rewrites the destination field on a matching change rule", () => {
    const hb = { project: "old", language: "Go" };
    const out = applyRules(hb, [rule({})]);
    expect(out).not.toBeNull();
    expect(out?.project).toBe("new");
    expect(out?.language).toBe("Go");
  });

  it("leaves non-matching heartbeats untouched", () => {
    const hb = { project: "keep" };
    expect(applyRules(hb, [rule({})])?.project).toBe("keep");
  });

  it("supports contains / starts_with / ends_with", () => {
    expect(applyRules({ project: "abcdef" }, [rule({ operation: "contains", source_value: "cd" })])?.project).toBe("new");
    expect(applyRules({ project: "work/x" }, [rule({ operation: "starts_with", source_value: "work/" })])?.project).toBe("new");
    expect(applyRules({ project: "x.tmp" }, [rule({ operation: "ends_with", source_value: ".tmp" })])?.project).toBe("new");
    expect(applyRules({ project: "nomatch" }, [rule({ operation: "contains", source_value: "zz" })])?.project).toBe("nomatch");
  });

  it("can rewrite across dimensions (entity → project)", () => {
    const hb = { entity: "/repo/secret.ts", project: "fallback" };
    const out = applyRules(hb, [
      rule({ source: "entity", operation: "contains", source_value: "secret", destination: "project", destination_value: "Secret" }),
    ]);
    expect(out?.project).toBe("Secret");
  });

  it("returns null (drops) on a matching hide rule", () => {
    const hb = { project: "work/secret" };
    const out = applyRules(hb, [rule({ action: "hide", operation: "starts_with", source_value: "work/", destination: "", destination_value: "" })]);
    expect(out).toBeNull();
  });

  it("applies rules sequentially: a change can set up a later rule's match", () => {
    const hb = { project: "a" };
    const out = applyRules(hb, [
      rule({ source_value: "a", destination_value: "b" }),
      rule({ source_value: "b", destination_value: "c" }),
    ]);
    expect(out?.project).toBe("c");
  });

  it("short-circuits on the first matching hide", () => {
    const hb = { project: "x" };
    const out = applyRules(hb, [
      rule({ action: "hide", source_value: "x", destination: "", destination_value: "" }),
      rule({ source_value: "x", destination_value: "should-not-apply" }),
    ]);
    expect(out).toBeNull();
  });

  it("skips rules whose source field is missing or non-string", () => {
    const hb = { language: "Go" }; // no project
    expect(applyRules(hb, [rule({})])).toEqual({ language: "Go" });
  });

  it("is a no-op for an empty rule set", () => {
    const hb = { project: "old" };
    expect(applyRules(hb, [])).toEqual({ project: "old" });
  });
});

describe("validateCustomRules", () => {
  const change = {
    action: "change",
    source: "project",
    operation: "equals",
    source_value: "old",
    destination: "project",
    destination_value: "new",
  };

  it("accepts a valid array and defaults priority to the array index", () => {
    const r = validateCustomRules([change, { action: "hide", source: "project", operation: "starts_with", source_value: "work/" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(2);
    expect(r.value[0].priority).toBe(0);
    expect(r.value[1].priority).toBe(1);
    // hide rule normalises destination fields to empty strings
    expect(r.value[1].destination).toBe("");
    expect(r.value[1].destination_value).toBe("");
  });

  it("accepts an empty array (clear all)", () => {
    const r = validateCustomRules([]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  it("honours an explicit priority", () => {
    const r = validateCustomRules([{ ...change, priority: 7 }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value[0].priority).toBe(7);
  });

  it("rejects a non-array body", () => {
    expect(validateCustomRules({}).ok).toBe(false);
    expect(validateCustomRules(null).ok).toBe(false);
  });

  it("rejects unknown enum values", () => {
    expect(validateCustomRules([{ ...change, action: "drop" }]).ok).toBe(false);
    expect(validateCustomRules([{ ...change, source: "nope" }]).ok).toBe(false);
    expect(validateCustomRules([{ ...change, operation: "regex" }]).ok).toBe(false);
  });

  it("requires a non-empty source_value", () => {
    expect(validateCustomRules([{ ...change, source_value: "" }]).ok).toBe(false);
  });

  it("requires destination + destination_value for change rules", () => {
    const noDest = validateCustomRules([{ action: "change", source: "project", operation: "equals", source_value: "x" }]);
    expect(noDest.ok).toBe(false);
    const emptyDestVal = validateCustomRules([{ ...change, destination_value: "" }]);
    expect(emptyDestVal.ok).toBe(false);
  });

  it("does not require destination for hide rules", () => {
    const r = validateCustomRules([{ action: "hide", source: "project", operation: "equals", source_value: "x" }]);
    expect(r.ok).toBe(true);
  });

  it("rejects a non-integer priority", () => {
    expect(validateCustomRules([{ ...change, priority: 1.5 }]).ok).toBe(false);
  });

  it("enforces the rule-count cap", () => {
    const many = Array.from({ length: MAX_RULES + 1 }, () => ({ ...change }));
    expect(validateCustomRules(many).ok).toBe(false);
  });
});
