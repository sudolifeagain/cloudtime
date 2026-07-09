/**
 * Unit tests for the pure commit coding-time correlation helpers
 * (specs/145-commit-duration-correlation/). Covers the shared per-pair gap
 * rule, window-bound resolution, and the `prev.project`-attributed active-time
 * sum — including the reviewer counterexamples that pin the derivation to
 * `computeDurations`' attribution (not a same-project pre-filter).
 */
import { describe, expect, it } from "vitest";
import { sessionGapSeconds } from "../../src/utils/session-gap";
import {
  CORRELATION_HEARTBEAT_LIMIT,
  MAX_CORRELATION_WINDOW,
  resolveWindow,
  sumActiveSeconds,
  type CorrelationRow,
} from "../../src/utils/commit-correlation";

describe("sessionGapSeconds", () => {
  it("counts a gap within the timeout", () => {
    expect(sessionGapSeconds(0, 100, 900)).toBe(100);
  });

  it("counts a gap exactly equal to the timeout (inclusive boundary)", () => {
    expect(sessionGapSeconds(0, 900, 900)).toBe(900);
  });

  it("drops an idle gap beyond the timeout", () => {
    expect(sessionGapSeconds(0, 901, 900)).toBe(0);
  });

  it("drops a zero gap (duplicate timestamp)", () => {
    expect(sessionGapSeconds(100, 100, 900)).toBe(0);
  });

  it("drops an out-of-order (negative) gap", () => {
    expect(sessionGapSeconds(200, 100, 900)).toBe(0);
  });
});

describe("resolveWindow", () => {
  it("uses the previous-commit bound when it is later than the capped floor", () => {
    // upper 10000, prev 9500, cap floor = 10000 - 86400 (far below) → prev wins
    expect(resolveWindow(10000, 9500, MAX_CORRELATION_WINDOW)).toBe(9500);
  });

  it("falls back to the capped floor when there is no previous commit", () => {
    expect(resolveWindow(100000, null, MAX_CORRELATION_WINDOW)).toBe(100000 - MAX_CORRELATION_WINDOW);
  });

  it("uses the capped floor when the previous commit is older than the cap", () => {
    // prev is 2 days before upper → floored to upper - 24h
    const upper = 1_000_000;
    const prev = upper - 2 * MAX_CORRELATION_WINDOW;
    expect(resolveWindow(upper, prev, MAX_CORRELATION_WINDOW)).toBe(upper - MAX_CORRELATION_WINDOW);
  });

  it("prefers the capped floor when prev equals the floor exactly (strict >)", () => {
    const upper = 500_000;
    const floor = upper - MAX_CORRELATION_WINDOW;
    expect(resolveWindow(upper, floor, MAX_CORRELATION_WINDOW)).toBe(floor);
  });
});

function rows(...pairs: Array<[number, string | null]>): CorrelationRow[] {
  return pairs.map(([time, project]) => ({ time, project }));
}

describe("sumActiveSeconds", () => {
  const P = "cloudtime";

  it("returns 0 for a single heartbeat (no pairs)", () => {
    expect(sumActiveSeconds(rows([0, P]), P, 900)).toBe(0);
  });

  it("returns 0 for an empty window", () => {
    expect(sumActiveSeconds([], P, 900)).toBe(0);
  });

  it("sums consecutive same-project gaps within the timeout", () => {
    // 0,60,120 → gaps 60 + 60
    expect(sumActiveSeconds(rows([0, P], [60, P], [120, P]), P, 900)).toBe(120);
  });

  it("excludes an idle gap beyond the timeout (matches summaries)", () => {
    // 0,60,120,[idle 1800],1920,1980 → 60 + 60 + 0 + 60
    expect(
      sumActiveSeconds(rows([0, P], [60, P], [120, P], [1920, P], [1980, P]), P, 900),
    ).toBe(180);
  });

  it("rounds the total to whole seconds", () => {
    // gap 1.6 → rounds to 2
    expect(sumActiveSeconds(rows([0, P], [1.6, P]), P, 900)).toBe(2);
  });

  it("credits an interleaved detour to the other project, not this commit", () => {
    // I (quickstart): cloudtime@0, other@120, cloudtime@240 → only the first gap counts for P
    const window = rows([0, P], [120, "other-proj"], [240, P]);
    expect(sumActiveSeconds(window, P, 900)).toBe(120);
    // and the detour interval is credited to the other project
    expect(sumActiveSeconds(window, "other-proj", 900)).toBe(120);
  });

  // Reviewer counterexamples (research D-4): a same-project pre-filter would
  // over-count the first and under-count the second; prev.project attribution
  // matches computeDurations/summaries exactly.
  it("counterexample A: P@0,Q@100,P@150 credits P only the first gap (100, not 150)", () => {
    const window = rows([0, P], [100, "Q"], [150, P]);
    expect(sumActiveSeconds(window, P, 900)).toBe(100);
    expect(sumActiveSeconds(window, "Q", 900)).toBe(50);
  });

  it("counterexample B: P@0,Q@800,P@1000 credits P the full 800 (not dropped as >timeout)", () => {
    const window = rows([0, P], [800, "Q"], [1000, P]);
    expect(sumActiveSeconds(window, P, 900)).toBe(800);
    // Q's gap (800→1000 = 200) is within timeout and credited to Q
    expect(sumActiveSeconds(window, "Q", 900)).toBe(200);
  });

  it("ignores null-project heartbeats (a commit's path project is never null)", () => {
    expect(sumActiveSeconds(rows([0, null], [60, null], [120, P]), P, 900)).toBe(0);
  });
});

describe("constants", () => {
  it("caps the window at 24h and the read at 5000 rows", () => {
    expect(MAX_CORRELATION_WINDOW).toBe(86400);
    expect(CORRELATION_HEARTBEAT_LIMIT).toBe(5000);
  });
});
