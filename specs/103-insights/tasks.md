# Tasks: Insights Endpoint

**Branch**: `103-insights`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Generated**: 2026-05-29

## PR1 — Spec + Design

- [x] **T-001**: Author `spec.md` (dimension + temporal stories, FR-001..FR-010, edge cases, first-cut type list, `hours` deferred).
- [x] **T-002**: Author `plan.md` (Constitution Check, route + builder sketches).
- [x] **T-003**: Author `research.md` (7 documented decisions).
- [x] **T-004**: Author `data-model.md` (summaries-only; single grouped read; per-type shaping).
- [x] **T-005**: Author `quickstart.md` (scenarios A–I).
- [x] **T-006**: Author `contracts/openapi-diff.md`.
- [x] **T-007**: Author `checklists/requirements.md`.
- [x] **T-008**: Add the per-type / range / reserved-param description to `insights.yaml`. No type-shape change.
- [x] **T-009**: Run `npm run generate` (JSDoc-only diff); run `npm run typecheck`.
- [ ] **T-010**: Commit PR1 (spec+schema, then types), push, open PR against `develop`.

## PR2 — Implementation (after PR1 merges)

### Builder

- [ ] **T-101**: `src/utils/insights.ts` — pure `buildInsight(type, rows, range, tz)` + helpers:
  - dimension → `SummaryItem[]` (group by column, NULL→`"Unknown"`, percent of total, desc, shared formatter)
  - `days[]`, `best_day`, `daily_average` (÷ active days)
  - `weekday` → `items[]` (English weekday name, mean per active occurrence, desc)
- [ ] **T-102**: Unit tests `tests/aggregation/insights.test.ts` over a fixed fixture for every type (tie-break, Unknown bucket, active-day average, weekday mean, zero-total percent).

### Route

- [ ] **T-103**: `src/routes/insights.ts` — validate `insight_type` against the enum; resolve `range` via `resolveStatsRange` (400 on either invalid); one grouped `summaries` SELECT scoped by `user_id`; dispatch to `buildInsight`; behind `authMiddleware`.
- [ ] **T-104**: Mount in `src/index.ts`: `app.route("/api/v1/users/current", insights)`.

### Tests

- [ ] **T-105**: `tests/integration/insights.test.ts` — endpoint per type against seeded `summaries`, validation 400s, cross-user isolation, 401, empty range.

### Verification

- [ ] **T-106**: `npm run typecheck` — zero errors.
- [ ] **T-107**: `npm test` — full suite green incl. new unit + integration.
- [ ] **T-108**: Manual run of `quickstart.md` A / D / E / H against a staging worker.

### PR2 submission

- [ ] **T-109**: Commit with `feat:` prefix, push, open PR against `develop` referencing PR1 and issue #103.

## Dependencies

```
T-001 .. T-009 → T-010                 (PR1)
T-010 → T-101 .. T-109                  (PR2 after PR1 merge)
T-101 → T-102
T-101 → T-103 → T-104
T-102 / T-104 → T-105
T-105 → T-106 → T-107 → T-108 → T-109
```

## Out of scope

- `hours`-of-day insight (needs an hourly aggregate).
- Applying `timeout` / `writes_only` (summaries can't honour them).
- New aggregate tables / schema changes.
- Response caching.
