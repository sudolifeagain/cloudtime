/**
 * The per-pair session-gap rule shared by the daily `summaries` aggregation
 * (`computeDurations`, src/cron/aggregate.ts) and per-commit coding-time
 * correlation (`sumActiveSeconds`, src/utils/commit-correlation.ts).
 *
 * Extracted so both consumers apply an identical idle/timeout rule and can
 * never silently diverge after a future tweak (spec 145 FR-005 / research D-4).
 * Pure: no D1, no I/O.
 */

/**
 * The counted seconds contributed by one consecutive heartbeat pair: the gap
 * when `0 < gap <= timeoutSec`, else `0` (an idle gap beyond the session
 * timeout, or a non-positive / out-of-order gap). Because a counted gap is
 * always `> 0`, a `0` return is an unambiguous "does not count".
 */
export function sessionGapSeconds(prevTime: number, currTime: number, timeoutSec: number): number {
  const gap = currTime - prevTime;
  return gap > 0 && gap <= timeoutSec ? gap : 0;
}
