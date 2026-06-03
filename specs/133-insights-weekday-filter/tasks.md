# Tasks: `weekday` filter for the `days` insight

**Branch**: `133-insights-weekday-filter`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Generated**: 2026-06-04 · **Issue**: #133

## PR1 — Spec + Design

- [x] **T-001**: Author `spec.md` (US1 filter, US2 invalid→400, US3 ignore on non-days; FR-001..FR-009; edge cases; SC-001..SC-005).
- [x] **T-002**: Author `plan.md` (Constitution Check, thin-route + pure-builder structure).
- [x] **T-003**: Author `research.md` (D-1..D-7: numbering, accepted forms, validation scope, timezone basis, filter location, type surface, scope).
- [x] **T-004**: Author `data-model.md` (no schema change; in-memory filter over existing per-date totals).
- [x] **T-005**: Author `quickstart.md` (scenarios A–H).
- [x] **T-006**: Author `contracts/openapi-diff.md` (descriptive-only change; JSDoc-only generate diff).
- [x] **T-007**: Author `checklists/requirements.md`.
- [x] **T-008**: Update `schemas/paths/insights/insights.yaml` — `days` field mapping note, reserved-params paragraph, and the `weekday` parameter description. No parameter add/remove, no 200/response shape change.
- [x] **T-009**: Run `npm run generate` (expect JSDoc-only diff in `src/types/generated.ts`); run `npm run typecheck`.
- [ ] **T-010**: Commit PR1 (artifacts + schema, then regenerated types), push, open PR against `develop` referencing #133.

## PR2 — Implementation (after PR1 merges)

### Builder

- [ ] **T-101**: `src/utils/insights.ts` — extend `buildInsight` to accept an optional resolved weekday filter (`0–6 | null`); in the `days` branch, keep only dates with `weekdayOf(date) === filter` when non-null. Reuse the existing `weekdayOf` helper. No other branch reads the filter.
- [ ] **T-102**: Unit tests `tests/aggregation/insights.test.ts` (extend) — filtered `days` for a known fixture; int/name equivalence at the builder level; empty result; non-`days` types unaffected when a filter is passed.

### Route

- [ ] **T-103**: `src/routes/insights.ts` — parse `weekday` query → normalised `0–6 | null` (trim, accept int 0–6 and case-insensitive name). For `insight_type === "days"`, return 400 when present-but-invalid; for other types, ignore (treat as `null`). Pass the resolved filter into `buildInsight`.

### Tests

- [ ] **T-104**: `tests/integration/insights.test.ts` (extend) — quickstart A–H: unfiltered baseline, name filter, int equivalence, case-insensitivity, empty, 400s (`funday`, `7`, blank), non-`days` ignore (valid + invalid), cross-user isolation, 401.

### Verification

- [ ] **T-105**: `npm run typecheck` — zero errors.
- [ ] **T-106**: `npm test` — full suite green incl. new/extended unit + integration.
- [ ] **T-107**: Manual run of `quickstart.md` B / C / E / F / G against a staging worker.

### PR2 submission

- [ ] **T-108**: Commit with `feat:` prefix, push, open PR against `develop` referencing PR1 and issue #133.

## Dependencies

```
T-001 .. T-009 → T-010                 (PR1)
T-010 → T-101 .. T-108                  (PR2 after PR1 merge)
T-101 → T-102
T-101 → T-103 → T-104
T-102 / T-104 → T-105 → T-106 → T-107 → T-108
```

## Out of scope

- Applying `timeout` / `writes_only` (summaries can't honour them).
- Weekday abbreviations (`mon`, `tue`) — additive later if needed.
- SQL-side filtering / any schema change.
- The `hours` insight type (#134) and other insight work.
