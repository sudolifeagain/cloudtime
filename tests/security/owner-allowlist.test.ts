/**
 * Unit tests for the owner allowlist matching rule (Issue #157,
 * specs/157-owner-allowlist/). The helper is pure so these tests carry the
 * security-relevant logic independently of the OAuth integration harness.
 */
import { describe, expect, it } from "vitest";
import { ownerAllowlistRejects } from "../../src/utils/owner-allowlist";

describe("ownerAllowlistRejects", () => {
  it("never rejects when the variable is unset (FR-001)", () => {
    expect(ownerAllowlistRejects(undefined, "anyone@example.test")).toBe(false);
    expect(ownerAllowlistRejects(undefined, null)).toBe(false);
  });

  it("never rejects when the variable is blank — gate inactive (FR-001)", () => {
    expect(ownerAllowlistRejects("", "anyone@example.test")).toBe(false);
    expect(ownerAllowlistRejects("   ", "anyone@example.test")).toBe(false);
    expect(ownerAllowlistRejects("\t \n", null)).toBe(false);
  });

  it("does not reject an exact match (FR-002)", () => {
    expect(ownerAllowlistRejects("owner@example.test", "owner@example.test")).toBe(false);
  });

  it("folds case and surrounding whitespace on both sides (FR-002, US1 scenario 4)", () => {
    expect(ownerAllowlistRejects(" Owner@Example.TEST ", "owner@example.test")).toBe(false);
    expect(ownerAllowlistRejects("owner@example.test", "  OWNER@EXAMPLE.test\t")).toBe(false);
  });

  it("rejects a mismatched email (FR-002)", () => {
    expect(ownerAllowlistRejects("owner@example.test", "intruder@example.test")).toBe(true);
    expect(ownerAllowlistRejects("owner@example.test", "owner@example.org")).toBe(true);
  });

  it("rejects a missing provider email when the variable is set — fail closed (FR-003)", () => {
    expect(ownerAllowlistRejects("owner@example.test", null)).toBe(true);
    expect(ownerAllowlistRejects("owner@example.test", "")).toBe(true);
  });

  it("returns only a boolean — no message material to leak (US3)", () => {
    const result = ownerAllowlistRejects("owner@example.test", "intruder@example.test");
    expect(typeof result).toBe("boolean");
  });
});
