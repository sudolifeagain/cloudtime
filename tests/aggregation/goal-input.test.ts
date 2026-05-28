/**
 * Unit tests for src/utils/goal-input.ts — pure validation for the Goals
 * CRUD request bodies (specs/100-goals-crud/). No D1, no I/O.
 */
import { describe, expect, it } from "vitest";
import {
  validateGoalInput,
  validateGoalUpdate,
  MAX_TARGET_SECONDS,
  MAX_TITLE,
} from "../../src/utils/goal-input";

const minimal = {
  title: "Code daily",
  type: "coding",
  delta: "day",
  target_seconds: 3600,
};

function expectFail<T>(result: { ok: boolean; error?: string }, fragment?: string) {
  expect(result.ok).toBe(false);
  if (fragment && !result.ok) {
    expect(result.error).toContain(fragment);
  }
}

describe("validateGoalInput", () => {
  it("accepts a minimal coding goal and applies boolean defaults", () => {
    const r = validateGoalInput(minimal);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      title: "Code daily",
      type: "coding",
      delta: "day",
      target_seconds: 3600,
      is_enabled: true,
      is_snoozed: false,
      is_inverse: false,
      languages: [],
      editors: [],
      projects: [],
    });
  });

  it("honours explicitly provided booleans", () => {
    const r = validateGoalInput({ ...minimal, is_enabled: false, is_snoozed: true, is_inverse: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.is_enabled).toBe(false);
    expect(r.value.is_snoozed).toBe(true);
    expect(r.value.is_inverse).toBe(true);
  });

  it("trims the title and rejects empty / whitespace / overlong titles", () => {
    const trimmed = validateGoalInput({ ...minimal, title: "  spaced  " });
    expect(trimmed.ok).toBe(true);
    if (trimmed.ok) expect(trimmed.value.title).toBe("spaced");

    expectFail(validateGoalInput({ ...minimal, title: "" }));
    expectFail(validateGoalInput({ ...minimal, title: "   " }));
    expectFail(validateGoalInput({ ...minimal, title: 123 as unknown as string }), "title");
    expectFail(validateGoalInput({ ...minimal, title: "x".repeat(MAX_TITLE + 1) }), "200");
  });

  it("rejects unknown type and delta", () => {
    expectFail(validateGoalInput({ ...minimal, type: "music" }), "type");
    expectFail(validateGoalInput({ ...minimal, delta: "fortnight" }), "delta");
  });

  it("enforces target_seconds bounds (0, 604800]", () => {
    expectFail(validateGoalInput({ ...minimal, target_seconds: 0 }), "target_seconds");
    expectFail(validateGoalInput({ ...minimal, target_seconds: -1 }));
    expectFail(validateGoalInput({ ...minimal, target_seconds: MAX_TARGET_SECONDS + 1 }));
    expectFail(validateGoalInput({ ...minimal, target_seconds: "3600" as unknown as number }));
    const boundary = validateGoalInput({ ...minimal, target_seconds: MAX_TARGET_SECONDS });
    expect(boundary.ok).toBe(true);
  });

  it("rejects non-boolean flags", () => {
    expectFail(validateGoalInput({ ...minimal, is_enabled: "yes" as unknown as boolean }), "is_enabled");
  });

  it("requires a non-empty matching array for filtered goal types", () => {
    expectFail(validateGoalInput({ ...minimal, type: "languages" }), "languages");
    expectFail(validateGoalInput({ ...minimal, type: "languages", languages: [] }), "languages");
    const ok = validateGoalInput({ ...minimal, type: "languages", languages: ["TypeScript"] });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.languages).toEqual(["TypeScript"]);
  });

  it("rejects filter arrays that do not match the type", () => {
    expectFail(validateGoalInput({ ...minimal, type: "coding", languages: ["Go"] }), "languages");
    expectFail(
      validateGoalInput({ ...minimal, type: "languages", languages: ["Go"], editors: ["VSCode"] }),
      "editors",
    );
  });

  it("rejects non-string array members and de-duplicates valid ones", () => {
    expectFail(
      validateGoalInput({ ...minimal, type: "languages", languages: ["Go", 7 as unknown as string] }),
      "languages",
    );
    const dedup = validateGoalInput({ ...minimal, type: "editors", editors: ["VSCode", "VSCode", "Vim"] });
    expect(dedup.ok).toBe(true);
    if (dedup.ok) expect(dedup.value.editors).toEqual(["VSCode", "Vim"]);
  });

  it("rejects a non-object body", () => {
    expectFail(validateGoalInput(null), "JSON object");
    expectFail(validateGoalInput([1, 2]), "JSON object");
    expectFail(validateGoalInput("string"), "JSON object");
  });
});

describe("validateGoalUpdate", () => {
  it("rejects a non-object body", () => {
    expectFail(validateGoalUpdate(null, "coding"), "JSON object");
  });

  it("rejects immutable type and delta", () => {
    expectFail(validateGoalUpdate({ type: "languages" }, "coding"), "immutable");
    expectFail(validateGoalUpdate({ delta: "week" }, "coding"), "immutable");
  });

  it("rejects an empty body or one with only unrecognised keys", () => {
    expectFail(validateGoalUpdate({}, "coding"), "at least one");
    expectFail(validateGoalUpdate({ nonsense: true } as Record<string, unknown>, "coding"), "at least one");
  });

  it("returns only the provided mutable fields", () => {
    const r = validateGoalUpdate({ target_seconds: 7200, is_snoozed: true }, "coding");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ target_seconds: 7200, is_snoozed: true });
    expect(r.value).not.toHaveProperty("title");
  });

  it("validates provided fields with the create rules", () => {
    expectFail(validateGoalUpdate({ title: "   " }, "coding"));
    expectFail(validateGoalUpdate({ target_seconds: 0 }, "coding"), "target_seconds");
    expectFail(validateGoalUpdate({ is_enabled: 1 as unknown as boolean }, "coding"), "is_enabled");
  });

  it("keeps filter arrays consistent with the goal's existing type", () => {
    // existing type is languages: matching array must stay non-empty
    expectFail(validateGoalUpdate({ languages: [] }, "languages"), "languages");
    const ok = validateGoalUpdate({ languages: ["Go", "Go", "Rust"] }, "languages");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.languages).toEqual(["Go", "Rust"]);

    // existing type is coding: cannot introduce a filter array
    expectFail(validateGoalUpdate({ languages: ["Go"] }, "coding"), "languages");

    // existing type is languages: cannot set a different dimension's array
    expectFail(validateGoalUpdate({ editors: ["VSCode"] }, "languages"), "editors");
  });
});
