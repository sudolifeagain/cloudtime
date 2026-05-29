# Acceptance Checklist: Global Stats Always Aggregate in UTC

## PR1 (Spec) gate — must be ✅ before merging

- [x] `spec.md` covers FR-001..FR-006 with no `[NEEDS CLARIFICATION]` markers.
- [x] `spec.md` records the decision (Option 1 UTC-fix) and why rate-limiting is not needed.
- [x] `plan.md` Constitution Check has all five principles marked PASS.
- [x] `research.md` documents the 4 decisions (option choice, param removal, no rate-limit, per-user untouched).
- [x] `data-model.md` confirms no schema change and documents the UTC range + single cache key.
- [x] `quickstart.md` enumerates scenarios A–E.
- [x] `tasks.md` separates PR1 from PR2.
- [x] `contracts/openapi-diff.md` documents the `timezone` param removal.
- [x] `global-stats.yaml` drops the `timezone` param, updates the description, and declares the invalid-range `400`.
- [x] `npm run generate` sets `getGlobalStats` query params to `never`, includes the `400` response; `npm run typecheck` passes.
- [x] PR1 contains no runtime code under `src/` (only regenerated `src/types/generated.ts`).
- [x] PR1 references issue #29.

## PR2 (Implementation) gate — must be ✅ before merging

### Code

- [ ] `src/routes/meta.ts` global-stats handler: resolve range in UTC (`resolveStatsRange(range)`), cache key `global-stats:{range}`, `range.timezone = "UTC"`; remove the `timezone` query read + `isValidTimezone` validation (and the now-unused import if applicable).
- [ ] The authenticated `src/routes/stats.ts` per-user handler is **unchanged**.
- [ ] `npm run typecheck` passes; no hand-edited generated types.

### Behaviour (per `quickstart.md`)

- [ ] A: `?timezone=…` ignored; `range.timezone` always `"UTC"`; identical payload.
- [ ] B: same `range` with different timezones hits one cache entry.
- [ ] C: invalid timezone → 200 (ignored), not 400.
- [ ] D: invalid range → 400 (unchanged).
- [ ] E: authenticated per-user stats still honour timezone.

### Tests

- [ ] `tests/integration/global-stats.test.ts` (or extend meta tests): timezone ignored (same data + `range.timezone` UTC across tz values), invalid timezone not rejected, invalid range 400.
- [ ] `npm test` stays green.

## Post-deployment gate

- [ ] Confirm `GET /stats/{range}?timezone=…` returns UTC and does not multiply cache entries.
- [ ] Confirm per-user `GET /users/current/stats/{range}` is unaffected.
