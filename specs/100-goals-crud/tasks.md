# Tasks: Goals CRUD Endpoints

**Branch**: `100-goals-crud`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Generated**: 2026-05-28

## PR1 — Spec + Design

- [x] **T-001**: Author `spec.md` (3 user stories, FR-001..FR-017, NFRs, edge cases).
- [x] **T-002**: Author `plan.md` (Constitution Check, validation + handler sketches).
- [x] **T-003**: Author `research.md` (8 documented decisions).
- [x] **T-004**: Author `data-model.md` (existing table; write-path field treatment + filter/type matrix).
- [x] **T-005**: Author `quickstart.md` (scenarios A–I).
- [x] **T-006**: Author `contracts/openapi-diff.md`.
- [x] **T-007**: Author `checklists/requirements.md`.
- [x] **T-008**: Add `GoalInput` and `GoalUpdate` request schemas; add `post` to `goals.yaml` and `patch` + `delete` to `goal.yaml`. Reuse `Goal` for create/update responses.
- [x] **T-009**: Run `npm run generate`. Verify `createGoal` / `updateGoal` / `deleteGoal` and `GoalInput` / `GoalUpdate` appear in `src/types/generated.ts` and that `GoalInput` booleans are optional. Run `npm run typecheck`.
- [ ] **T-010**: Commit PR1 (spec+schema, then types), push, open PR against `develop`.

## PR2 — Implementation (after PR1 merges)

### Validation helper

- [ ] **T-101**: Create `src/utils/goal-input.ts` exporting:
  - `validateGoalInput(body): { ok: true, value: ValidatedGoalCreate } | { ok: false, error }`
  - `validateGoalUpdate(body, existingType): { ok: true, value: Partial<...> } | { ok: false, error }`
  - shared constants `MAX_TITLE = 200`, `MAX_TARGET_SECONDS = 604800`
- [ ] **T-102**: Unit tests in `tests/aggregation/goal-input.test.ts` (or `tests/security/`): title trim/length, target range incl. boundary, type/delta enums, filter/type matrix, de-duplication, defaults, immutable-field rejection, empty-update rejection, non-JSON body.

### Route handlers (extend existing `src/routes/goals.ts`)

- [ ] **T-103**: `POST /goals` — validate, `crypto.randomUUID()`, single `INSERT` (filter arrays as JSON TEXT or NULL), re-SELECT, return `201 {data: Goal}`.
- [ ] **T-104**: `PATCH /goals/:goal_id` — ownership SELECT (404 if absent), validate against existing `type`, dynamic `SET` from a fixed allowlist + `modified_at = datetime('now')`, re-SELECT, return `200 {data: Goal}`.
- [ ] **T-105**: `DELETE /goals/:goal_id` — single `DELETE ... WHERE id = ? AND user_id = ?`; `204` on `changes>0`, else `404`.
- [ ] **T-106**: Reuse `rowToGoal`, `GOAL_COLUMNS`, and the single-goal SELECT; factor a small `selectGoalRow(db, id, userId)` helper if it reduces duplication.

### Tests

- [ ] **T-107**: Integration test `tests/integration/goals-crud.test.ts` covering scenarios A–H (two users seeded for cross-user 404).

### Verification

- [ ] **T-108**: `npm run typecheck` — zero errors.
- [ ] **T-109**: `npm test` — full suite green incl. new unit + integration.
- [ ] **T-110**: Manual run of `quickstart.md` Scenarios A, D, F, G against a staging worker.

### PR2 submission

- [ ] **T-111**: Commit with `feat:` prefix, push, open PR against `develop` referencing PR1 and issue #100.

## Dependencies

```
T-001 .. T-009 → T-010                       (PR1)
T-010 → T-101 .. T-111                        (PR2 starts after PR1 merge)
T-101 → T-102                                 (helper before its tests)
T-101 → T-103 / T-104                         (handlers depend on validation)
T-103 / T-104 / T-105 → T-106                 (shared SELECT helper)
T-102 / T-103 / T-104 / T-105 → T-107         (integration needs full surface)
T-107 → T-108 → T-109 → T-110 → T-111
```

## Out of scope

- Bulk create / bulk delete.
- `type` / `delta` mutation (immutable; recreate instead).
- Goal templates, suggestions, notifications.
- Soft delete / archive (use `is_enabled=false`).
- Goal reordering or custom week-start.
