/**
 * Unit tests for src/utils/commit-input.ts — the pure commit ingestion
 * validator (specs/135-commits-ingestion/). No D1, no I/O.
 */
import { describe, expect, it } from "vitest";
import { validateCommitInput } from "../../src/utils/commit-input";

function ok(body: unknown) {
  const r = validateCommitInput(body);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.value;
}

describe("validateCommitInput", () => {
  it("accepts a minimal body (hash only) and nulls the rest", () => {
    const v = ok({ hash: "abc123" });
    expect(v.hash).toBe("abc123");
    expect(v.message).toBeNull();
    expect(v.author_date).toBeNull();
    expect(v.total_seconds).toBeNull();
    expect(v.ref).toBeNull();
  });

  it("passes through all string fields and total_seconds", () => {
    const v = ok({
      hash: "abc123",
      message: "fix: thing",
      author_name: "Nao",
      author_email: "nao@example.com",
      ref: "main",
      url: "https://example.com/c/abc123",
      total_seconds: 1800,
    });
    expect(v.message).toBe("fix: thing");
    expect(v.author_name).toBe("Nao");
    expect(v.ref).toBe("main");
    expect(v.total_seconds).toBe(1800);
  });

  it("normalizes dates to UTC SQLite datetime (no millis), matching created_at", () => {
    expect(ok({ hash: "h", author_date: "2026-06-05T01:00:00Z" }).author_date).toBe("2026-06-05 01:00:00");
    // Offset is converted to UTC.
    expect(ok({ hash: "h", author_date: "2026-06-05T10:00:00+09:00" }).author_date).toBe("2026-06-05 01:00:00");
    // Date-only is widened to a full datetime (so the read path stays schema-valid).
    expect(ok({ hash: "h", committer_date: "2026-06-05" }).committer_date).toBe("2026-06-05 00:00:00");
  });

  it("rejects a missing, blank, or non-string hash", () => {
    expect(validateCommitInput({ message: "x" }).ok).toBe(false);
    expect(validateCommitInput({ hash: "" }).ok).toBe(false);
    expect(validateCommitInput({ hash: 123 }).ok).toBe(false);
  });

  it("rejects a negative or non-numeric total_seconds", () => {
    expect(validateCommitInput({ hash: "h", total_seconds: -1 }).ok).toBe(false);
    expect(validateCommitInput({ hash: "h", total_seconds: "30" }).ok).toBe(false);
    // null / omitted are allowed.
    expect(ok({ hash: "h", total_seconds: null }).total_seconds).toBeNull();
  });

  it("rejects unparseable date-times", () => {
    expect(validateCommitInput({ hash: "h", author_date: "not-a-date" }).ok).toBe(false);
    expect(validateCommitInput({ hash: "h", committer_date: "32 of Maybe" }).ok).toBe(false);
  });

  it("rejects non-string optional string fields", () => {
    expect(validateCommitInput({ hash: "h", message: 5 }).ok).toBe(false);
    expect(validateCommitInput({ hash: "h", ref: true }).ok).toBe(false);
  });

  it("rejects a non-object body", () => {
    expect(validateCommitInput(null).ok).toBe(false);
    expect(validateCommitInput([{ hash: "h" }]).ok).toBe(false);
    expect(validateCommitInput("hash=h").ok).toBe(false);
  });
});
