# Tasks: Global Stats Always Aggregate in UTC

**Branch**: `029-global-stats-utc`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Generated**: 2026-05-29

## PR1 — Spec + Design

- [x] **T-001**: Author `spec.md` (problem, Option 1 decision, FR-001..FR-005, scenarios).
- [x] **T-002**: Author `plan.md` (Constitution Check, handler sketch).
- [x] **T-003**: Author `research.md` (4 documented decisions).
- [x] **T-004**: Author `data-model.md` (no schema change; UTC range + single cache key).
- [x] **T-005**: Author `quickstart.md` (scenarios A–E).
- [x] **T-006**: Author `contracts/openapi-diff.md`.
- [x] **T-007**: Author `checklists/requirements.md`.
- [x] **T-008**: Remove the `timezone` query param from `global-stats.yaml`; rewrite the description (UTC, rationale); declare the invalid-range `400`.
- [x] **T-009**: Run `npm run generate` (getGlobalStats query → never; `400` response present); run `npm run typecheck`.
- [ ] **T-010**: Commit PR1 (spec+schema, then types), push, open PR against `develop`.

## PR2 — Implementation (after PR1 merges)

### Handler

- [ ] **T-101**: `src/routes/meta.ts` — resolve range in UTC (`resolveStatsRange(rangeParam)`), set cache key `global-stats:${rangeParam}`, `range.timezone = "UTC"`; remove the `timezone` query read + `isValidTimezone` validation; drop the `isValidTimezone` import if unused.

### Tests

- [ ] **T-102**: `tests/integration/global-stats.test.ts` — timezone ignored (same data + `range.timezone` UTC across tz values; single cache entry), invalid timezone not rejected (200), invalid range 400; assert per-user stats unaffected (smoke).

### Verification

- [ ] **T-103**: `npm run typecheck` — zero errors.
- [ ] **T-104**: `npm test` — full suite green incl. the new test.
- [ ] **T-105**: Manual `quickstart.md` A / B / C against a staging worker.

### PR2 submission

- [ ] **T-106**: Commit with `fix:` prefix, push, open PR against `develop` referencing PR1 and issue #29.

## Dependencies

```
T-001 .. T-009 → T-010            (PR1)
T-010 → T-101 → T-102 → T-103 → T-104 → T-105 → T-106   (PR2)
```

## Out of scope

- Per-IP rate limiting (Option 3); a UTC date column in `summaries` (Option 4);
  the authenticated per-user stats endpoint.
