/**
 * Boundary tests for the write-input length caps (Issue #158, FR-002/FR-003):
 * one at-cap accept and one over-cap reject per representative field of each
 * pure validator. The heartbeat validator's boundaries are covered by the
 * endpoint integration tests (tests/integration/heartbeats.test.ts).
 */
import { describe, expect, it } from "vitest";
import { INPUT_LIMITS } from "../../src/utils/input-limits";
import { validateCommitInput } from "../../src/utils/commit-input";
import { validateExternalDuration } from "../../src/utils/external-duration-input";
import { validateCustomRules } from "../../src/utils/custom-rule-input";

describe("commit input caps (#158)", () => {
  it("accepts at-cap values", () => {
    const result = validateCommitInput({
      hash: "a".repeat(INPUT_LIMITS.commitHash),
      message: "m".repeat(INPUT_LIMITS.commitMessage),
      author_email: "e".repeat(INPUT_LIMITS.email),
      url: "u".repeat(INPUT_LIMITS.url),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects over-cap values naming the field", () => {
    const hash = validateCommitInput({ hash: "a".repeat(INPUT_LIMITS.commitHash + 1) });
    expect(hash).toEqual({ ok: false, error: `hash must be at most ${INPUT_LIMITS.commitHash} characters` });

    const ref = validateCommitInput({ hash: "abc", ref: "r".repeat(INPUT_LIMITS.name + 1) });
    expect(ref).toEqual({ ok: false, error: `ref must be at most ${INPUT_LIMITS.name} characters` });
  });
});

describe("external duration input caps (#158)", () => {
  const base = {
    external_id: "evt-1",
    entity: "Meeting",
    type: "app",
    start_time: 1_750_000_000,
    end_time: 1_750_000_600,
  };

  it("accepts at-cap values", () => {
    const result = validateExternalDuration({
      ...base,
      external_id: "i".repeat(INPUT_LIMITS.externalId),
      entity: "e".repeat(INPUT_LIMITS.entity),
      meta: "m".repeat(INPUT_LIMITS.meta),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects over-cap values naming the field", () => {
    const entity = validateExternalDuration({ ...base, entity: "e".repeat(INPUT_LIMITS.entity + 1) });
    expect(entity).toEqual({ ok: false, error: `entity must be at most ${INPUT_LIMITS.entity} characters` });

    const meta = validateExternalDuration({ ...base, meta: "m".repeat(INPUT_LIMITS.meta + 1) });
    expect(meta).toEqual({ ok: false, error: `meta must be at most ${INPUT_LIMITS.meta} characters` });
  });
});

describe("custom rule input caps (#158)", () => {
  it("accepts at-cap rule values", () => {
    const result = validateCustomRules([
      {
        action: "change",
        source: "entity",
        operation: "starts_with",
        source_value: "s".repeat(INPUT_LIMITS.ruleValue),
        destination: "project",
        destination_value: "d".repeat(INPUT_LIMITS.ruleValue),
      },
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects over-cap rule values naming the field", () => {
    const source = validateCustomRules([
      { action: "hide", source: "entity", operation: "contains", source_value: "s".repeat(INPUT_LIMITS.ruleValue + 1) },
    ]);
    expect(source).toEqual({
      ok: false,
      error: `rule[0].source_value must be at most ${INPUT_LIMITS.ruleValue} characters`,
    });

    const destination = validateCustomRules([
      {
        action: "change",
        source: "project",
        operation: "equals",
        source_value: "p",
        destination: "project",
        destination_value: "d".repeat(INPUT_LIMITS.ruleValue + 1),
      },
    ]);
    expect(destination).toEqual({
      ok: false,
      error: `rule[0].destination_value must be at most ${INPUT_LIMITS.ruleValue} characters`,
    });
  });
});
