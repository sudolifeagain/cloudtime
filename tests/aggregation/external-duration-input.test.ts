/**
 * Unit tests for src/utils/external-duration-input.ts (specs/106-external-durations/).
 * Pure validation — no D1.
 */
import { describe, expect, it } from "vitest";
import { validateExternalDuration } from "../../src/utils/external-duration-input";

const valid = {
  external_id: "evt-1",
  entity: "Standup",
  type: "app",
  start_time: 1_717_000_000,
  end_time: 1_717_000_900,
};

describe("validateExternalDuration", () => {
  it("accepts a valid body and normalises optional fields to null", () => {
    const r = validateExternalDuration(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.external_id).toBe("evt-1");
    expect(r.value.type).toBe("app");
    expect(r.value.category).toBeNull();
    expect(r.value.project).toBeNull();
  });

  it("keeps provided optional strings", () => {
    const r = validateExternalDuration({ ...valid, category: "meeting", project: "Personal" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.category).toBe("meeting");
      expect(r.value.project).toBe("Personal");
    }
  });

  it("allows end_time == start_time (zero-length marker)", () => {
    expect(validateExternalDuration({ ...valid, end_time: valid.start_time }).ok).toBe(true);
  });

  it("rejects missing required fields", () => {
    expect(validateExternalDuration({ ...valid, external_id: undefined }).ok).toBe(false);
    expect(validateExternalDuration({ ...valid, entity: "" }).ok).toBe(false);
  });

  it("rejects an unknown type", () => {
    expect(validateExternalDuration({ ...valid, type: "meeting" }).ok).toBe(false);
  });

  it("rejects non-numeric or reversed times", () => {
    expect(validateExternalDuration({ ...valid, start_time: "1" as unknown as number }).ok).toBe(false);
    expect(validateExternalDuration({ ...valid, end_time: valid.start_time - 1 }).ok).toBe(false);
  });

  it("rejects a non-object body", () => {
    expect(validateExternalDuration(null).ok).toBe(false);
    expect(validateExternalDuration([valid]).ok).toBe(false);
  });

  it("rejects a non-string optional field", () => {
    expect(validateExternalDuration({ ...valid, project: 5 as unknown as string }).ok).toBe(false);
  });
});
