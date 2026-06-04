# Tasks: `hours`-of-day insight

**Branch**: `134-insights-hours-of-day`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Generated**: 2026-06-05 · **Issue**: #134

## PR1 — Spec + Design

- [x] **T-001**: Author `spec.md` (US1 profile, US2 first-class type; FR-001..FR-010; edge cases; SC-001..SC-005).
- [x] **T-002**: Author `plan.md` (Constitution Check; same-pass cron design; schema.sql deferred to PR2 per project workflow).
- [x] **T-003**: Author `research.md` (D-1 aggregate-table strategy, D-2 same-pass/cursor, D-3 mean-per-active-day, D-4 hour-boundary attribution, D-5 response shape, D-6 forward-only/backfill, D-7 numbering/timezone).
- [x] **T-004**: Author `data-model.md` (`hourly_summaries` DDL; write/read paths; in-memory fold; daily_average invariant).
- [x] **T-005**: Author `quickstart.md` (scenarios A–H).
- [x] **T-006**: Author `contracts/openapi-diff.md` (enum value + `Insight.hours[]` + prose; additive generate diff).
- [x] **T-007**: Author `checklists/requirements.md`.
- [x] **T-008**: Update `schemas/paths/insights/insights.yaml` — add `hours` to the enum; rewrite the data-source paragraph; add the `hours` field-mapping bullet.
- [x] **T-009**: Update `schemas/components/schemas/Insight.yaml` — add the `hours[]` field.
- [x] **T-010**: Run `npm run generate` (expect additive enum literal + `Insight.hours[]` in `src/types/generated.ts`); run `npm run typecheck`.
- [x] **T-011**: Commit PR1 in SDD order (spec/schemas, then regenerated types), push, open PR against `develop` referencing #134.

## PR2 — Implementation (after PR1 merges)

### Timezone helper
- [x] **T-101**: `src/utils/time-format.ts` — add `getHourForTimestamp(epochSeconds, tz?) -> 0..23` mirroring `getDateForTimestamp` (reuse `Intl.DateTimeFormat` with `hourCycle: "h23"`; UTC fast path).
- [x] **T-102**: Unit tests for `getHourForTimestamp` (UTC, a +/- offset zone, a DST boundary).

### Cron (same pass as summaries)
- [x] **T-103**: `src/db/schema.sql` — add the `hourly_summaries` table + unique index.
- [x] **T-104**: `src/cron/aggregate.ts` — in `computeDurations`, also accumulate `(userId, date, hour)` totals; batch-UPSERT `hourly_summaries` in the same `db.batch()` as `summaries`; share the `last_aggregated_at` cursor.
- [x] **T-105**: Aggregation tests `tests/aggregation/hourly-aggregate.test.ts` — hour bucketing in UTC and a non-UTC tz; hour-boundary attribution to the starting heartbeat; both aggregates advance together.

### Builder + route
- [x] **T-106**: `src/utils/insights.ts` — add `buildHoursInsight`: fold per-`(date,hour)` rows into 24 buckets, mean = sum/distinct-active-days, ascending by hour; add `hours` to `INSIGHT_TYPES`.
- [x] **T-107**: `src/routes/insights.ts` — for `insight_type === "hours"`, issue the `hourly_summaries` SELECT and pass its rows to the builder; other types unchanged.
- [x] **T-108**: Unit tests `tests/aggregation/insights.test.ts` (extend) — 24-bucket shape, mean math, empty → 24 zeros, sums-to-daily_average invariant.

### Integration + verification
- [x] **T-109**: `tests/integration/insights.test.ts` (extend) — profile, daily_average equality, empty range, year/month + range names, 400, 401, reserved-params ignored, cross-user isolation. (Timezone bucketing is covered at the cron layer in T-105.)
- [x] **T-110**: `npm run typecheck` — zero errors.
- [x] **T-111**: `npm test` — full suite green (308 tests) incl. new/extended unit + aggregation + integration.
- [ ] **T-112**: Commit with `feat:` prefix, push, open PR against `develop` referencing PR1 and issue #134.

## Dependencies

```
T-001 .. T-010 → T-011                  (PR1)
T-011 → T-101 .. T-112                   (PR2 after PR1 merge)
T-101 → T-102
T-101 → T-103 → T-104 → T-105
T-106 → T-107 → T-108 → T-109
T-105 / T-109 → T-110 → T-111 → T-112
```

## Out of scope

- Backfilling `hourly_summaries` from historical heartbeats (research D-6) — optional ops follow-up.
- Applying `timeout` / `writes_only` / `weekday` to `hours` (they stay ignored).
- Splitting a duration across hour boundaries (research D-4).
- Any change to the daily `summaries` shape or the other insight types.
