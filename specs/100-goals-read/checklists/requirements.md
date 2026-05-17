# Acceptance Checklist: Goals Read Endpoints

## PR1 (Spec) gate — must be ✅ before merging

- [ ] `spec.md` covers FR-001..FR-012 with no `[NEEDS CLARIFICATION]` markers.
- [ ] `plan.md` Constitution Check has all five principles marked PASS.
- [ ] `research.md` documents the 9 design decisions.
- [ ] `data-model.md` confirms no schema change is required.
- [ ] `quickstart.md` enumerates scenarios A–J.
- [ ] `tasks.md` separates PR1 from PR2 with dependency arrows.
- [ ] `contracts/openapi-diff.md` documents only description-level YAML changes.
- [ ] `schemas/paths/goals/goals.yaml`, `schemas/paths/goals/goal.yaml`, and
      `schemas/components/schemas/Goal.yaml` carry the clarifying description text.
- [ ] `npm run generate` produces a JSDoc-only diff in `src/types/generated.ts`.
- [ ] PR1 contains no changes under `src/routes/goals.ts`, `src/utils/goal-chart.ts`,
      or `src/index.ts`.
- [ ] PR1 references this feature folder and explicitly notes that CRUD is out of scope.

## PR2 (Implementation) gate — must be ✅ before merging

### Code

- [ ] `src/utils/goal-chart.ts` exports the helper API listed in `tasks.md` T-101.
- [ ] `src/routes/goals.ts` exports a Hono sub-app with both endpoints
      behind `authMiddleware`.
- [ ] Cross-user request returns 404 (verified by integration test).
- [ ] List endpoint omits `chart_data` and `status` from each Goal in the response.
- [ ] `npx tsc --noEmit` passes with zero errors.
- [ ] No diff in `src/routes/heartbeats.ts`, `src/routes/summaries.ts`,
      `src/routes/stats.ts`, or any auth-flow file.

### Behaviour (per `quickstart.md`)

- [ ] Scenario A: empty list returns `{"data":[]}`.
- [ ] Scenario B: populated list returns ordered entries without chart_data.
- [ ] Scenario C: single goal returns chart_data of length 7 with correct
      actuals against a seeded summary set.
- [ ] Scenario D: `type=languages` filter excludes non-matching summary rows.
- [ ] Scenario E: `delta=week` periods span ISO Mon-Sun in the user's timezone.
- [ ] Scenario F: `is_inverse=true` flips success/fail semantics.
- [ ] Scenario G: `is_snoozed=true` forces top-level `status=pending` while
      preserving per-range statuses.
- [ ] Scenario H: cross-user 404.
- [ ] Scenario I: unauthenticated 401.
- [ ] Scenario J: timezone-shifted day attribution is correct.

### Tests

- [ ] `tests/aggregation/goal-chart.test.ts` covers DST transitions, ISO week
      boundaries, equality at target, inverse semantics, snoozed override.
- [ ] `tests/integration/goals-read.test.ts` covers scenarios A, B, C, D, F,
      G, H, I (J is manual due to TZ + cron coupling).
- [ ] `npm test` reports 88+ tests passing (existing 79 + ≥9 new).

### Documentation

- [ ] `docs/auth-design.md` no change required (Goals are user-scoped, not auth-flow).
- [ ] No new operator runbook required (no env vars added).

## Post-deployment gate

- [ ] Spot-check a real user's `GET /goals/{id}` response and compare
      `chart_data[i].actual_seconds` to a direct
      `SELECT SUM(total_seconds) FROM summaries WHERE date = ?` query for
      the same period.
- [ ] No 500 responses logged for Goals endpoints in the first 7 days.
- [ ] If any goal row has malformed `languages` / `editors` / `projects` JSON,
      confirm the warning log fires and the endpoint still returns 200.
