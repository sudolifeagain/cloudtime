# Research: Insights Endpoint

## Decision 1: Derive from `summaries`, never raw heartbeats

**Decision**: All first-cut insights are computed from the pre-aggregated `summaries` table via a single grouped `SELECT` over the range's date window.

**Rationale**:
- `summaries` is already bucketed per user / date / dimension by the cron aggregator; reading it is O(matches), heartbeats would be O(raw events) and blow the 10ms CPU budget.
- Mirrors `/summaries`, `/stats`, and goals chart computation — consistent behaviour and one source of truth.

**Alternative considered**: live heartbeat scan for accuracy. Rejected — cost, and the cron lag (≤1h) is irrelevant at day/range granularity.

---

## Decision 2: `hours` insight deferred

**Decision**: No `hours`-of-day insight in the first cut. It is not in the declared `insight_type` enum and is out of scope.

**Rationale**:
- `summaries` has **day** granularity (`date`), not hour. An hours insight needs either an hourly aggregate (extend the cron to write per-hour rows) or a raw-heartbeat scan — both larger than this feature.
- Adding it later is additive (new enum value + new aggregate), no break to the shipped types.

**Alternative considered**: scan heartbeats at query time for the hours view only. Rejected for the first cut — inconsistent cost profile vs the other types; revisit with a dedicated hourly aggregate.

---

## Decision 3: Reuse the `/stats` range vocabulary

**Decision**: `range` is resolved with the existing `resolveStatsRange(range, tz)` helper — `last_7_days`, `last_30_days`, `last_6_months`, `last_year`, `all_time`, `YYYY`, `YYYY-MM`. Invalid → 400.

**Rationale**:
- One range vocabulary across `/stats` and `/insights` means one mental model and one tested implementation. No reason to invent a parallel parser.

**Alternative considered**: a bespoke insights range set. Rejected — needless divergence.

---

## Decision 4: `daily_average` divides by **active** days

**Decision**: `daily_average.seconds = range_total ÷ (count of distinct dates with any summary row in range)`. Zero when there are no active days.

**Rationale**:
- Dividing by calendar days breaks `all_time` (start = 1970) — the average would round to ~0. Active-day averaging gives a meaningful "on days you coded, you averaged X".
- Matches the intuitive "daily coding average" most tools show.

**Alternative considered**: divide by calendar days in range. Rejected — meaningless for long/open ranges.

---

## Decision 5: `weekday` represented as `items[]`

**Decision**: The `weekday` insight populates `items[]` with one `SummaryItem` per occurring weekday: `name` = English weekday (`Monday`…`Sunday`), `total_seconds` = mean of that weekday's active-day totals, ordered most-active-first.

**Rationale**:
- The `Insight` schema has no weekday-specific field; `items[]` is the existing generic list shape and fits ("which weekday do I code most").
- Mean per **active** occurrence (consistent with Decision 4) avoids diluting by weekday occurrences that had no activity.

**Alternative considered**: add a dedicated `weekdays` field to `Insight`. Rejected — avoids a schema change; `items[]` is sufficient and already typed.

---

## Decision 6: NULL dimension values bucket under `"Unknown"`

**Decision**: When grouping a dimension (e.g. `language`) and the column is NULL, those rows are summed under a stable `"Unknown"` item rather than dropped.

**Rationale**:
- Dropping NULLs would make `percent` not sum to 100% and hide real time. A visible `"Unknown"` bucket is honest and matches how dashboards present unattributed time.

**Alternative considered**: drop NULLs. Rejected — distorts totals/percentages.

---

## Decision 7: `timeout` / `writes_only` / `weekday` reserved, not applied

**Decision**: The declared `timeout`, `writes_only`, and `weekday` query params are accepted (no 400) but not applied in the first cut.

**Rationale**:
- `summaries` already bake in each user's session timeout during aggregation and do not retain per-heartbeat write flags, so those cannot be honoured without a raw-heartbeat scan (which Decision 1 rules out).
- `weekday` is an existing query parameter on the declared operation, but the first cut defines `weekday` as an insight type, not as a filter on `days`; applying both meanings in PR2 would be ambiguous.
- Keeping the params accepted avoids breaking the declared contract and leaves room to honour them if insights ever move to a raw-scan path.

**Alternative considered**: remove the params, or 400 when supplied. Rejected — unnecessary contract churn; silently-accepted-but-documented is least disruptive.
