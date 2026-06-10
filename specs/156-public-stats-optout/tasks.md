# Tasks: Instance-level opt-out for the public global stats endpoint

**Input**: Design documents from `specs/156-public-stats-optout/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/openapi-diff.md, quickstart.md

**Organization**: The SpecKit 2-PR rule splits delivery: Phase 1 is PR1 (this branch — contract only); Phases 2+ are PR2 (implementation, after PR1 merges). Tests are included because the spec's Independent Test criteria and the project testing baseline require integration coverage for endpoint behavior changes.

## Phase 1: Setup — PR1, contract only (this branch)

**Goal**: Land the documented contract (404 on `getGlobalStats`) and regenerated types with zero behavior change.

- [ ] T001 Apply the contract diff in `specs/156-public-stats-optout/contracts/openapi-diff.md` to `schemas/paths/meta/global-stats.yaml`: add the `'404'` response (`$ref: ../../components/responses/NotFound.yaml`) after `'400'`, and append the `PUBLIC_STATS` paragraph to the operation `description`. Commit the spec change on its own.
- [ ] T002 Run `npm run generate`; verify via `git diff src/types/generated.ts` that the only changes are the additive `404` response on `getGlobalStats` and updated operation JSDoc. Commit the regenerated output separately (never hand-edit).
- [ ] T003 Run `npm run typecheck`; push branch `156-public-stats-optout` and open PR1 targeting `develop`, referencing Issue #156 and noting "spec + types only, implementation in PR2".

**Checkpoint**: PR1 open and green. Phases below start only after PR1 merges, on a fresh branch off `develop`.

## Phase 2: Foundational — PR2 prerequisite (blocking all user stories)

- [ ] T004 Add `PUBLIC_STATS?: string` (with an operator-facing comment: trimmed, case-insensitive `"false"` disables the public global stats endpoint; anything else/unset = enabled) to the `Env` interface in `src/types.ts`.

## Phase 3: User Story 1 — Operator disables the public profile (P1) 🎯 MVP

**Goal**: With `PUBLIC_STATS="false"`, every `GET /api/v1/stats/{range}` request returns the standard `404` body before any cache or DB work.

**Independent Test**: Run the integration suite with `{ PUBLIC_STATS: "false" }` env overrides — valid and invalid ranges both return identical `404` bodies and no `global-stats:*` KV entry is written.

- [ ] T005 [US1] In `src/routes/meta.ts`, add the disabled gate as the first statement of the `getGlobalStats` handler: if `(c.env.PUBLIC_STATS ?? "").trim().toLowerCase() === "false"`, return `404` with the standard error body and `Cache-Control: no-store` — before `resolveStatsRange`, the KV read, and the D1 batch (plan "Structure Decision", research D-3/D-4).
- [ ] T006 [US1] Add integration tests in `tests/integration/global-stats.test.ts` (env-override pattern from `tests/integration/pending-link-verify.test.ts`): disabled + valid range → 404; disabled + invalid range → 404 with an identical body (FR-002); disabled requests write no `global-stats:*` KV entry and serve no pre-seeded cache entry (FR-003, spec US1 scenario 3).

**Checkpoint**: US1 deliverable — the privacy switch works end-to-end.

## Phase 4: User Story 2 — Existing deployments unaffected by default (P2)

**Goal**: Unset, `"true"`, or unrecognized values leave behavior byte-for-byte unchanged.

**Independent Test**: The existing `global-stats` integration cases pass unmodified with `PUBLIC_STATS` unset; re-running them with `"true"` and a garbage value yields identical results.

- [ ] T007 [P] [US2] Extend `tests/integration/global-stats.test.ts`: with `PUBLIC_STATS` unset, `"true"`, and an unrecognized value (e.g. `"no"`), a valid range returns the current `200`/`202` body and an invalid range returns `400`; cache population behavior unchanged (FR-001, FR-005, spec US2).

## Phase 5: User Story 3 — Only the global stats endpoint is affected (P3)

**Goal**: The switch is not an accidental kill-switch for other endpoints.

**Independent Test**: With `PUBLIC_STATS="false"`, the other public endpoints and an authenticated per-user stats request respond exactly as before.

- [ ] T008 [P] [US3] Extend `tests/integration/global-stats.test.ts`: with `PUBLIC_STATS="false"`, assert `/api/v1/health`, `/api/v1/meta`, `/api/v1/editors`, `/api/v1/program_languages` return `200`, and an authenticated `GET /api/v1/users/current/stats/last_7_days` (fixture user via `tests/helpers/fixtures.ts`) responds unchanged (FR-006, spec US3).

## Phase 6: Polish & Cross-Cutting

- [ ] T009 [P] Add a commented `PUBLIC_STATS` entry under `[vars]` in `wrangler.toml` documenting the exact disabling value and the default (FR-008).
- [ ] T010 [P] Add a privacy section to `docs/deployment-guide.md` recommending `PUBLIC_STATS = "false"` for single-user instances unless a public profile is intended; cross-link from the global-stats notes in `docs/timezone-behavior.md` if a pointer fits naturally (FR-008, SC-004).
- [ ] T011 Run `npm run typecheck && npm test` (all suites green); open PR2 targeting `develop`, referencing Issue #156 and PR1.

## Dependencies

- T001 → T002 → T003 (strict commit order, Constitution I)
- PR1 merge gates everything below
- T004 blocks T005 (type must exist before the handler reads it)
- T005 blocks T006 (tests exercise the gate)
- T006, T007, T008 are independent of each other once T005 lands ([P] where marked)
- T009, T010 independent of code tasks; T011 last

## Parallel Example

After T005 merges into the PR2 working branch:

```text
# Run in parallel — different concerns, same test file extended in separate describe blocks:
T007 [US2] default-behavior cases
T008 [US3] scope cases
T009 wrangler.toml comment
T010 deployment-guide section
```

## Implementation Strategy

MVP = Phase 3 (US1): the switch existing and returning blanket `404`s is the entire audit remediation. US2 is regression assurance (the code change for it is zero — only tests), US3 is scope assurance. Ship PR2 as one small PR; the stories stay independently verifiable through their test blocks.
