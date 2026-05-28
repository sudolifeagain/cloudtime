# Acceptance Checklist: Goals CRUD Endpoints

## PR1 (Spec) gate — must be ✅ before merging

- [x] `spec.md` covers FR-001..FR-017 with no `[NEEDS CLARIFICATION]` markers.
- [x] `plan.md` Constitution Check has all five principles marked PASS.
- [x] `research.md` documents the 8 design decisions (immutability, 404, hard delete, empty-PATCH 400, pure validation module, JSON filter storage, two schemas, server-side defaults).
- [x] `data-model.md` confirms no schema change and documents the write-path field treatment + filter/type matrix.
- [x] `quickstart.md` enumerates scenarios A–I.
- [x] `tasks.md` separates PR1 from PR2 with dependency arrows.
- [x] `contracts/openapi-diff.md` documents the POST/PATCH/DELETE additions and the `GoalInput` / `GoalUpdate` schemas.
- [x] `schemas/paths/goals/goals.yaml` declares `post` (`createGoal`).
- [x] `schemas/paths/goals/goal.yaml` declares `patch` (`updateGoal`) and `delete` (`deleteGoal`).
- [x] `schemas/components/schemas/GoalInput.yaml` and `GoalUpdate.yaml` exist and encode the request contracts.
- [x] `npm run generate` produces generated types with `createGoal`/`updateGoal`/`deleteGoal` operations and `GoalInput`/`GoalUpdate` components; `GoalInput` booleans are optional.
- [x] `npm run typecheck` passes.
- [x] PR1 contains no changes under `src/routes/goals.ts`, `src/utils/goal-input.ts`, or `src/index.ts`.
- [x] PR1 references issue #100 and the read-path PRs (#95 / #96).

## PR2 (Implementation) gate — must be ✅ before merging

### Code

- [ ] `src/utils/goal-input.ts` exports `validateGoalInput` and `validateGoalUpdate` returning a discriminated `{ ok, value | error }` result.
- [ ] `src/routes/goals.ts` adds `POST /goals`, `PATCH /goals/:goal_id`, `DELETE /goals/:goal_id`, all behind the existing `authMiddleware`.
- [ ] Create generates `id` via `crypto.randomUUID()` and ignores body-supplied `id`/`created_at`/`modified_at`.
- [ ] PATCH builds its `SET` clause from a fixed column allowlist (no user-supplied column names) and always bumps `modified_at`.
- [ ] All three statements are scoped by `user_id`; cross-user PATCH/DELETE returns 404.
- [ ] Create/update responses reuse the existing `rowToGoal` decoder (no duplicate decoder).
- [ ] `npm run typecheck` passes with zero errors.
- [ ] No diff in the read handlers' behaviour, `goal-chart.ts`, or any auth-flow file.

### Behaviour (per `quickstart.md`)

- [ ] Scenario A: minimal create returns 201 with defaults applied.
- [ ] Scenario B: filtered create persists and echoes the filter array.
- [ ] Scenario C: each validation failure returns 400 and creates nothing.
- [ ] Scenario D: PATCH changes only the provided fields and bumps `modified_at`.
- [ ] Scenario E: PATCH with `type`/`delta`/empty body returns 400.
- [ ] Scenario F: DELETE returns 204 and the goal is gone.
- [ ] Scenario G: cross-user PATCH/DELETE returns 404, target untouched.
- [ ] Scenario H: unauthenticated POST/PATCH/DELETE returns 401.
- [ ] Scenario I: created goal round-trips through the read endpoints.

### Tests

- [ ] `tests/aggregation/goal-input.test.ts` (or `tests/security/`) covers the pure validation rules: title trim/length, target range incl. boundary 604800, type/delta enums, filter/type matrix, de-duplication, default application, immutable-field rejection, empty-update rejection.
- [ ] `tests/integration/goals-crud.test.ts` covers scenarios A–H against a seeded in-memory D1 (two users for the cross-user case).
- [ ] `npm test` stays green and adds coverage (existing suite + new unit + integration).

### Documentation

- [ ] No new operator runbook required (no env vars / bindings added).
- [ ] `quickstart.md` commands verified against a staging worker for at least Scenarios A, D, F, G.

## Post-deployment gate

- [ ] Create a goal through the API on a real instance and confirm it appears in `GET /goals`.
- [ ] Confirm no 500s logged for the mutation endpoints in the first 7 days.
- [ ] Confirm a cross-user DELETE attempt (if reproducible) returns 404 and does not remove the row.
