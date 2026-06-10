/**
 * Pins the write-input caps to the values documented in the OpenAPI schemas
 * and specs/158-input-maxlength/data-model.md (FR-007, research R-6).
 * openapi-typescript does not surface maxLength in generated types, so this
 * test is the drift guard between contract and validators.
 */
import { describe, expect, it } from "vitest";
import { INPUT_LIMITS, tooLong, truncateTo } from "../../src/utils/input-limits";

describe("INPUT_LIMITS parity with the OpenAPI contract (#158)", () => {
  it("matches the documented cap table exactly", () => {
    expect(INPUT_LIMITS).toEqual({
      entity: 4096,
      name: 255,
      userAgent: 512,
      dependenciesString: 8192,
      dependenciesItems: 100,
      dependencyName: 255,
      commitHash: 64,
      commitMessage: 4096,
      email: 254,
      url: 2048,
      externalId: 255,
      meta: 8192,
      ruleValue: 1024,
    });
  });
});

describe("tooLong / truncateTo", () => {
  it("caps are inclusive: at-cap passes, cap+1 fails (FR-003)", () => {
    expect(tooLong("x".repeat(255), 255)).toBe(false);
    expect(tooLong("x".repeat(256), 255)).toBe(true);
    expect(tooLong("", 255)).toBe(false);
  });

  it("truncateTo returns the capped prefix and leaves short values untouched", () => {
    expect(truncateTo("x".repeat(600), 512)).toHaveLength(512);
    expect(truncateTo("short", 512)).toBe("short");
    expect(truncateTo("x".repeat(512), 512)).toHaveLength(512);
  });
});
