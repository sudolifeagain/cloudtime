# Research & Decisions: `hours`-of-day insight

**Branch**: `134-insights-hours-of-day` | **Date**: 2026-06-05

Documented decisions that shape the contract. Each records the choice, the alternatives, and why.

## D-1: Aggregation strategy — a per-hour pre-aggregate table

**Decision**: Add a `hourly_summaries` table at (`user_id`, local `date`, local `hour`) granularity, populated by the hourly cron. Serve the insight from it.

**Why**: `summaries` is day-granular and cannot answer an hour-of-day question. The two candidates in #134 are (a) an hourly aggregate table, or (b) scanning raw `heartbeats` at query time. (b) is rejected: an `all_time` / `last_year` `hours` request would scan an unbounded number of heartbeats inside a single request, blowing the Workers 10ms CPU budget, and `heartbeats` may already be purged past the retention window. (a) keeps the request to one indexed read of a small aggregate, consistent with how every other insight is served.

**Alternatives rejected**: query-time heartbeat scan (b) — unbounded request cost, breaks under retention purging. Reusing `summaries` with a synthetic hour column — would require re-aggregating raw data anyway and bloats the daily table.

## D-2: Populate in the same cron pass, off the same cursor

**Decision**: Bucket each duration into both `summaries` (by `date`) and `hourly_summaries` (by `date`+`hour`) in the **same** `computeDurations` walk, batch-UPSERT both in the same `db.batch()`, and advance the single existing `last_aggregated_at` cursor for both.

**Why**: The cron already performs exactly one heartbeat scan per run and already computes each interval's owning heartbeat. Deriving that heartbeat's hour is a constant-time addition; no second scan, no second cursor, no risk of the two aggregates drifting out of sync. This honours the incremental-cron constraint (process only data since `last_aggregated_at`).

**Alternatives rejected**: a separate `last_hourly_aggregated_at` cursor + independent pass — doubles the heartbeat scan cost and invites skew between the daily and hourly views for no benefit at our scale.

## D-3: Mean per active day (denominator = distinct active dates in range)

**Decision**: `hours[h].total_seconds = (sum of seconds bucketed to hour h across the range) / (count of distinct dates with any activity in the range)`.

**Why**: This yields a "typical active day" profile and has a clean, testable property: the 24 buckets sum to the `daily_average` insight's `seconds` (both divide the same grand total by the same active-day count). It mirrors how `daily_average` already defines an average over active days, so the two insights agree.

**Alternatives rejected**:
- *Per-hour active-day denominator* (divide each hour by the number of days that had activity **in that hour**, the way the `weekday` insight averages per weekday): inflates sparse hours and breaks the "sums to daily_average" property; less intuitive as a daily profile.
- *Raw totals (no averaging)*: the insight is defined as an average ("mean coding time per hour"); totals would just duplicate what a summed query already shows and scale with range length.
- *Denominator = all calendar days in range* (including zero-activity days): drags the profile toward zero for sparse users and diverges from `daily_average`'s active-day basis.

## D-4: Hour-boundary attribution follows the existing `date` rule

**Decision**: Attribute a whole duration interval `[prev, curr)` to the hour-of-day of `prev` (its starting heartbeat), exactly as aggregation already attributes the interval to `prev`'s `date`.

**Why**: Consistency with the daily aggregation and simplicity. An interval is at most one session timeout (≤ 60 min, `MAX_USER_TIMEOUT`), so attributing it wholly to the starting hour displaces at most that much time into the neighbouring hour — a bounded, well-understood approximation. Splitting an interval across hour boundaries would add complexity (and a date-rollover case) for negligible accuracy gain at our granularity.

**Alternatives rejected**: proportional split across hour boundaries — more code, a midnight-rollover edge, and no meaningful change to a coarse hour-of-day profile.

## D-5: Response shape — a dedicated `hours[]` field, always 24 buckets

**Decision**: Add a top-level `hours[]` array to the `Insight` schema, each entry `{hour: 0–23, total_seconds, text}`, always 24 entries ordered ascending by `hour` (zero-activity hours included as `total_seconds: 0`).

**Why**: A dedicated field parallels the existing `days[]` / `best_day` / `daily_average` modeling (insight_type `days` → field `days`, so `hours` → field `hours`), and a self-describing integer `hour` reads better than overloading `SummaryItem.name` with an hour string (the `items[]` route used by dimension/`weekday` insights). A fixed 24-bucket shape lets a client render an hour-of-day chart unconditionally, with no gaps to fill in. The field is additive — existing insight responses are unchanged.

**Alternatives rejected**:
- *Reuse `items[]` (`SummaryItem`)* like the `weekday` insight — would put the hour into `name` as a string and carry irrelevant fields (`percent`, `digital`, `hours`/`minutes`/`seconds`); a typed `hour` integer is cleaner. (Note `SummaryItem.hours` is the integer hour component of a duration — unrelated to this array; no real collision.)
- *Sparse, activity-sorted array* like `weekday` — convenient for a leaderboard but awkward for a 24-hour profile chart; the stable 24-bucket order is more useful here.

## D-6: Forward-only population; backfill is an optional follow-up

**Decision**: `hourly_summaries` is filled by the cron going forward from when the table is introduced. The `hours` insight is correct for all activity aggregated on or after that point. A one-time backfill is **not** part of this feature.

**Why**: The daily `summaries` were themselves built incrementally and have already discarded the hour, so the hourly table cannot be reconstructed from `summaries`. It could only be backfilled from raw `heartbeats` that are still within the retention window — a bounded, instance-specific one-off (e.g. a `wrangler d1 execute` migration or a throttled cron task) that does not belong in this contract. Calling this out keeps the limitation explicit rather than implying historical hour data appears retroactively.

**Alternatives rejected**: forcing a full backfill in PR2 — impossible where heartbeats are purged, and a request-time backfill would violate the CPU budget; reset of `last_aggregated_at` to re-aggregate — would double-count the daily `summaries` UPSERTs.

## D-7: `hour` numbering and timezone basis

**Decision**: `hour` is an integer `0–23` on a 24-hour clock (`h23`), computed in the user's profile timezone, on the same basis aggregation uses for `summaries.date`.

**Why**: Aligns with the daily `date` bucketing (user-profile timezone at aggregation time) so the two aggregates describe the same local calendar. The 24-hour clock is unambiguous and locale-independent. PR2 adds a `getHourForTimestamp(epoch, tz)` helper mirroring the existing `getDateForTimestamp`, reusing the same `Intl.DateTimeFormat(... hourCycle: "h23")` machinery already present in `time-format.ts`.

**Alternatives rejected**: 12-hour clock / AM-PM strings — locale-dependent and harder to sort/aggregate; UTC hours — would disagree with the user's local `date` bucketing.
