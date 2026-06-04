# Implementation Plan: `hours`-of-day insight

**Branch**: `134-insights-hours-of-day` | **Date**: 2026-06-05 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/134-insights-hours-of-day/spec.md`

## Summary

Add the `hours`-of-day insight type, backed by a new `hourly_summaries` pre-aggregate maintained by the existing hourly cron (same pass, same `last_aggregated_at` cursor as `summaries`). The insight reports a stable 24-bucket profile of mean coding time per hour-of-day, computed in the user's profile timezone. Strategy (a) from #134 (a per-hour aggregate table) is chosen over scanning raw heartbeats at query time, which is rejected for large ranges under the Workers 10ms CPU budget.

**PR1 (this PR)**: SpecKit artifacts + OpenAPI changes (`hours` enum value, operation prose, new `Insight.hours[]` field) + the `hourly_summaries` table in `src/db/schema.sql` + regenerated types. **No cron or route/business logic.**

**PR2 (after PR1 merges)**: extend the cron to populate `hourly_summaries` in the same pass; add the `hours` read path + builder; unit + integration tests.

> **Why `schema.sql` lands in PR1**: Issue #134 explicitly scopes "add the hourly aggregate table to `src/db/schema.sql`" to PR1. The table is part of the data-model contract that PR2's cron and read path depend on; it contains no business logic. This is a deliberate, issue-directed exception to the "schemas only" shorthand for PR1 — it stays SDD-compliant (data model defined before the code that uses it).

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers)
**Primary Dependencies**: Hono >= 4.9.7
**Storage**: D1 — adds `hourly_summaries` (new table); reads it for the insight. `summaries` unchanged.
**Testing**: Vitest + workers pool — unit tests for the pure `hours` builder; aggregation tests for the cron's hour bucketing; integration tests for the endpoint (24-bucket shape, mean math, empty range, timezone, 400/401).
**Performance Goals**: <10ms CPU — one read of `hourly_summaries` per request + an O(active rows) in-memory fold; the cron gains hour bucketing inside the existing single heartbeat scan (no extra scan).
**Constraints**: incremental cron (process only data since `last_aggregated_at`); no raw-heartbeat scan at request time.

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | Spec + OpenAPI + data model (schema.sql) land first (PR1); cron/route/builder follow in PR2. Types regenerated, never hand-edited. |
| II. Cloudflare-Native | PASS | Reuses the single hourly cron pass and one cursor for both aggregates (no second scan); request reads one pre-aggregate. D1 batch UPSERT for the new table (PR2). |
| III. Type Safety | PASS | Handler will use `components["schemas"]["Insight"]`; the new `hours[]` field is generated, not hand-written. |
| IV. Legal/Trademark | PASS | Semantics derived from our own `summaries`/`daily_average` model; no third-party source consulted. |
| V. Simplicity First | PASS | One new narrow table (4 columns), one new enum value, one new builder branch. Reuses the existing cron walk and timezone helpers. |

## Project Structure

### Documentation (this feature)

```text
specs/134-insights-hours-of-day/
├── plan.md
├── spec.md
├── research.md
├── data-model.md
├── quickstart.md
├── tasks.md
├── contracts/
│   └── openapi-diff.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
# PR1
schemas/paths/insights/insights.yaml      # CHANGE: add `hours` to enum; update operation prose + field mapping
schemas/components/schemas/Insight.yaml   # CHANGE: add `hours[]` field
src/db/schema.sql                         # CHANGE: add `hourly_summaries` table + unique index
src/types/generated.ts                    # REGENERATED (npm run generate)

# PR2 (after PR1 merges)
src/utils/time-format.ts                  # CHANGE: add getHourForTimestamp(epoch, tz) -> 0..23
src/cron/aggregate.ts                      # CHANGE: also bucket each duration into (user, date, hour); batch-UPSERT hourly_summaries in the same pass
src/utils/insights.ts                      # CHANGE: add the `hours` builder branch (24-bucket mean profile)
src/routes/insights.ts                     # CHANGE: for insight_type === "hours", read hourly_summaries instead of summaries
```

**Structure Decision**: Keep the per-request read path thin and the math pure. The cron change is additive — the existing `computeDurations` walk already determines each interval's owning heartbeat and `date`; PR2 also derives that heartbeat's `hour` and accumulates a second map keyed by `(userId, date, hour)`, then batch-UPSERTs it alongside the daily summaries in the same `db.batch()`. The route, for `insight_type === "hours"`, issues a single `SELECT date, hour, total_seconds FROM hourly_summaries WHERE user_id = ? AND date BETWEEN ? AND ?` and hands the rows to a pure builder that folds them into the 24-bucket mean profile (distinct dates → active-day denominator). No other insight branch is touched.

## Phases

- **PR1 — Spec + Design (this PR)**: author the SpecKit set; add `hours` to the enum and the `Insight.hours[]` field; document the operation prose; add `hourly_summaries` to `schema.sql`; `npm run generate`; `npm run typecheck`.
- **PR2 — Implementation**: `getHourForTimestamp` helper + cron hour bucketing + `hours` builder + route read path + unit/aggregation/integration tests; `npm test` green; open PR referencing #134 and PR1.

## Risks & Mitigations

- **Forward-only data on existing instances** (the new table starts empty) → documented as a known limitation (spec Edge Cases, research D-6); a bounded backfill from still-retained `heartbeats` is an optional, separate follow-up — the contract is correct for all data aggregated after introduction.
- **Storage growth** (up to 24 rows/active-day/user) → comparable to or below `summaries` (which stores one row per dimension tuple per day); acceptable for D1 at single-user scale. Noted in data-model.
- **Hour-boundary attribution skew** → bounded by the session timeout (≤ 60 min) and consistent with the existing `date` attribution; documented (FR-009, research D-4).
- **Type drift** → the `hours[]` field is generated from the OpenAPI schema; the generate diff is reviewed to confirm only the additive `Insight` change + the new enum value.
