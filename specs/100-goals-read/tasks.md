# Tasks: Goals Read Endpoints

**Branch**: `100-goals-read`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Generated**: 2026-05-17

## PR1 — Spec + Design

- [x] **T-001**: Author `spec.md` (3 user stories, FR-001..FR-012, NFRs, edge cases).
- [x] **T-002**: Author `plan.md` (Constitution Check, sketches).
- [x] **T-003**: Author `research.md` (9 documented decisions).
- [x] **T-004**: Author `data-model.md` (uses existing tables only).
- [x] **T-005**: Author `quickstart.md` (scenarios A–J).
- [x] **T-006**: Author `contracts/openapi-diff.md` (minor description clarifications).
- [x] **T-007**: Author `checklists/requirements.md`.
- [x] **T-008**: Split the OpenAPI response contract so `Goal` contains only persisted fields and `GoalWithChart` requires `chart_data` and `status` for the single-goal endpoint.
- [x] **T-009**: Run `npm run generate`. Verify `src/types/generated.ts` reflects the `Goal` / `GoalWithChart` response split.
- [x] **T-010**: Commit PR1, push, open PR against `develop`.

## PR2 — Implementation (after PR1 merges)

### Helper

- [ ] **T-101**: Create `src/utils/goal-chart.ts` exporting:
  - `buildDayRanges(today: Date, userTz: string, count = 7)`
  - `buildWeekRanges(today: Date, userTz: string, count = 7)` (ISO 8601 Monday-Sunday)
  - `classifyRange(actual: number, target: number, isInverse: boolean, isCurrent: boolean)`
  - `topStatus(entries: ChartEntry[], isSnoozed: boolean)`
- [ ] **T-102**: Add unit tests in `tests/aggregation/goal-chart.test.ts` covering DST transitions, ISO week edge cases, equality at target, inverse semantics, and snoozed override.

### Route handler

- [ ] **T-103**: Create `src/routes/goals.ts` exporting a Hono sub-app with:
  - `GET /goals` listing the user's goals (no chart_data).
  - `GET /goals/:id` returning `{ data: GoalWithChart }` with chart_data + status.
  - Both behind `authMiddleware`.
- [ ] **T-104**: Decode `languages` / `editors` / `projects` JSON columns defensively; treat invalid JSON as `[]` with a `console.warn` containing the goal id but not the raw value.
- [ ] **T-105**: Implement the summary-totals SQL with parameterised `IN (?, ?, ...)` for filtered goal types. Guard against zero-length filter arrays (the query degenerates to "no rows" by intent).

### Wiring

- [ ] **T-106**: Mount the sub-app in `src/index.ts`:
  ```ts
  import goals from "./routes/goals";
  // ...
  app.route("/api/v1/users/current", goals);
  ```

### Tests

- [ ] **T-107**: Integration test in `tests/integration/goals-read.test.ts`:
  - Empty list returns `{"data":[]}` (scenario A).
  - Populated list returns ordered entries without chart_data (scenario B).
  - Single goal returns chart_data of length 7 with correct actuals after seeding summaries (scenario C).
  - `type=languages` filter excludes non-matching summary rows (scenario D).
  - `is_inverse=true` flips success/fail semantics (scenario F).
  - `is_snoozed=true` forces top-level `status=pending` while leaving per-period statuses computed normally (scenario G).
  - Cross-user 404 (scenario H).
  - Unauthenticated 401 (scenario I).

### Verification

- [ ] **T-108**: `npx tsc --noEmit` — zero errors.
- [ ] **T-109**: `npm test` — all 79+ tests pass plus new unit + integration.
- [ ] **T-110**: Manual run of `quickstart.md` scenarios against a staging worker for at least scenarios C and J (timezone + chart correctness).

### PR2 submission

- [ ] **T-111**: Commit with `feat:` prefix. Push, open PR against `develop` referencing PR1.

## Dependencies

```
T-001 .. T-009 → T-010                              (PR1)
T-010 → T-101 .. T-111                              (PR2 starts after PR1 merge)
T-101 → T-102                                       (helper before its tests)
T-101 → T-103 → T-104 → T-105                       (handler stack)
T-103 → T-106                                       (must exist before mounting)
T-102 / T-105 / T-106 → T-107                       (integration test needs full surface)
T-107 → T-108 → T-109 → T-110 → T-111
```

## Out of scope

- POST / PATCH / DELETE on goals (future spec).
- Notifications, email, or push when status flips.
- Goal templates or recommendations.
- History beyond 7 periods.
- Cross-user "team goals" / shared goals.
