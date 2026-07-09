/**
 * Pure helpers for server-side commit coding-time correlation
 * (specs/145-commit-duration-correlation/). Given a commit's attribution
 * window and the heartbeats inside it, derive the coding time by summing the
 * same idle-trimmed, `prev.project`-attributed gaps the daily `summaries`
 * aggregation counts (research D-4). No D1, no I/O — the route
 * (src/routes/commits.ts) performs the reads and passes the rows in.
 */
import { sessionGapSeconds } from "./session-gap";

/** 24h ceiling on the lookback window when there is no recent previous commit. */
export const MAX_CORRELATION_WINDOW = 24 * 60 * 60; // 86400 seconds
/** Row cap on the in-window heartbeat read (mirrors the cron's HEARTBEAT_LIMIT). */
export const CORRELATION_HEARTBEAT_LIMIT = 5000;

/**
 * Resolve the window's lower bound (epoch seconds): the later of the previous
 * commit's boundary and the capped floor `upperEpoch - maxWindow`. A missing
 * previous commit (`null`) falls back to the capped floor, so the lookback is
 * always bounded (research D-3 / D-6).
 */
export function resolveWindow(
  upperEpoch: number,
  prevEpoch: number | null,
  maxWindow: number,
): number {
  const cappedFloor = upperEpoch - maxWindow;
  return prevEpoch != null && prevEpoch > cappedFloor ? prevEpoch : cappedFloor;
}

/** One in-window heartbeat: its epoch `time` and (nullable) `project`. */
export interface CorrelationRow {
  time: number;
  project: string | null;
}

/**
 * Sum the active coding seconds attributed to `commitProject` across a
 * `time`-ascending heartbeat window. Each consecutive gap is credited to the
 * EARLIER heartbeat's `project` (mirroring `computeDurations`' `prev.project`
 * attribution), idle-trimmed by the shared {@link sessionGapSeconds} rule, and
 * counted only when that project equals the commit's path project — so
 * interleaved other-project heartbeats are excluded, not absorbed. Rounds to
 * whole seconds (the `summaries` convention). Pure.
 */
export function sumActiveSeconds(
  sortedRows: CorrelationRow[],
  commitProject: string,
  timeoutSec: number,
): number {
  let derived = 0;
  for (let i = 1; i < sortedRows.length; i++) {
    const prev = sortedRows[i - 1];
    if (prev.project !== commitProject) continue;
    derived += sessionGapSeconds(prev.time, sortedRows[i].time, timeoutSec);
  }
  return Math.round(derived);
}
