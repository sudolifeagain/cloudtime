# Acceptance Checklist: Insights Endpoint

## PR1 (Spec) gate — must be ✅ before merging

- [x] `spec.md` covers FR-001..FR-010 (dimension + temporal insights) with no `[NEEDS CLARIFICATION]` markers.
- [x] `spec.md` explicitly lists the first-cut insight types and defers `hours`.
- [x] `plan.md` Constitution Check has all five principles marked PASS.
- [x] `research.md` documents the 7 design decisions (summaries-only, hours deferral, range reuse, active-day average, weekday-as-items, Unknown bucket, reserved params including `weekday`).
- [x] `data-model.md` confirms no schema change and documents the single grouped read + per-type shaping.
- [x] `quickstart.md` enumerates scenarios A–I.
- [x] `tasks.md` separates PR1 from PR2 with dependency arrows.
- [x] `contracts/openapi-diff.md` documents the contract clarification, explicit 400 response, and per-type field mapping.
- [x] `insights.yaml` carries the per-type / range / reserved-param description and explicit 400 response.
- [x] `npm run generate` produces the documented JSDoc plus 400 response type; `npm run typecheck` passes.
- [x] PR1 contains no runtime code under `src/` (only regenerated `src/types/generated.ts`).
- [x] PR1 references issue #103.

## PR2 (Implementation) gate — must be ✅ before merging

### Code

- [ ] `src/utils/insights.ts` exports a pure `buildInsight(type, rows, range, tz)` plus helpers for dimension items, days/best_day/daily_average, and weekday; reuses the shared duration formatter for `digital`/`text`.
- [ ] `src/routes/insights.ts` validates `insight_type` (enum) and resolves `range` via `resolveStatsRange` (400 on either invalid), issues one grouped `summaries` SELECT scoped by `user_id`, behind `authMiddleware`.
- [ ] `src/index.ts` mounts the router at `/api/v1/users/current`.
- [ ] `npm run typecheck` passes; no hand-edited generated types.

### Behaviour (per `quickstart.md`)

- [ ] A/B: dimension insights group, order desc, percent of total, Unknown bucket for NULLs.
- [ ] C: `days` active dates ascending.
- [ ] D: `best_day` = max-total date (earliest on tie).
- [ ] E: `daily_average` divides by active days.
- [ ] F: `weekday` items per weekday, mean per active occurrence, ordered desc.
- [ ] G: `all_time` / `YYYY` / `YYYY-MM` ranges scope correctly; all_time daily_average not diluted.
- [ ] H: invalid `insight_type` and `range` → 400.
- [ ] I: empty range → 200 empty/zeroed; unauthenticated → 401.

### Tests

- [ ] `tests/aggregation/insights.test.ts` — pure builder over a fixed fixture for every type (incl. tie-break, Unknown bucket, active-day average, weekday mean, zero-total percent).
- [ ] `tests/integration/insights.test.ts` — endpoint per type against seeded `summaries`, validation 400s, cross-user isolation, 401.
- [ ] `npm test` stays green with the new coverage.

## Post-deployment gate

- [ ] Spot-check `languages` / `best_day` / `daily_average` against a direct `summaries` query for a real user.
- [ ] No 500s on the endpoint in the first 7 days.
