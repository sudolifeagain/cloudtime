# Tasks: Optional owner allowlist for the single-user first login

**Input**: Design documents from `specs/157-owner-allowlist/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/openapi-diff.md, quickstart.md

**Organization**: Phase 1 is PR1 (this branch — documentation contract only); Phases 2+ are PR2 (implementation, after PR1 merges). Tests are included because the spec's Independent Test criteria and the project testing baseline require them; the security-relevant matching rule is deliberately a pure helper so its tests do not depend on the new OAuth harness (research D-6).

## Phase 1: Setup — PR1, documentation contract only (this branch)

**Goal**: Land the documented owner-allowlist behavior on the `oauthCallback` operation with zero behavior change.

- [ ] T001 Apply the contract diff in `specs/157-owner-allowlist/contracts/openapi-diff.md` to `schemas/paths/auth/provider-callback.yaml`: append security-checks list item 7 (single-user owner allowlist) to the operation `description`. Commit the spec change on its own.
- [ ] T002 Run `npm run generate`; verify via `git diff src/types/generated.ts` that the only change is the `oauthCallback` description JSDoc. Commit the regenerated output separately (never hand-edit).
- [ ] T003 Run `npm run typecheck`; push branch `157-owner-allowlist` and open PR1 targeting `develop`, referencing Issue #157 and noting "spec + types only, implementation in PR2".

**Checkpoint**: PR1 open and green. Phases below start only after PR1 merges, on a fresh branch off `develop`.

## Phase 2: Foundational — PR2 prerequisites (blocking all user stories)

- [ ] T004 [P] Add `ALLOWED_OWNER_EMAIL?: string` to the `Env` interface in `src/types.ts` with an operator-facing comment (non-blank value gates the single-user first-login bootstrap to the matching provider-verified email; unset/blank = inactive; see research D-1/D-3).
- [ ] T005 [P] Create `src/utils/owner-allowlist.ts`: pure `ownerAllowlistRejects(allowedRaw: string | undefined, providerEmail: string | null): boolean` — `false` when `allowedRaw` is unset or blank after trim; otherwise trimmed, case-insensitive comparison with a null/absent email counting as a rejection (fail closed, research D-3).
- [ ] T006 [P] Add `ALLOWED_OWNER_EMAIL?: string` to the test Env augmentation in `tests/env.d.ts`.

## Phase 3: User Story 1 — Operator pins the owner identity (P1) 🎯 MVP

**Goal**: With the variable set on an unbootstrapped single-user instance, only the matching verified email can create the owner.

**Independent Test**: Helper unit tests prove the matching rule; the integration callback test (or quickstart Scenario 2 manually) proves only the allowed identity bootstraps.

- [ ] T007 [P] [US1] Create `tests/security/owner-allowlist.test.ts` covering: unset and blank/whitespace-only `allowedRaw` → never rejects (FR-001); exact match and case/whitespace-folded match → not rejected (FR-002, spec US1 scenario 4); mismatched email → rejected (FR-002); `null` email with the variable set → rejected (FR-003).
- [ ] T008 [US1] Wire the gate in `src/routes/auth/login.ts`: immediately after `const isSingleUser = c.env.INSTANCE_MODE !== "multi";` in the new-user creation section, when `isSingleUser && ownerAllowlistRejects(c.env.ALLOWED_OWNER_EMAIL, userInfo.providerEmail)`, log `[owner-allowlist] rejected provider=<provider> reason=<email-mismatch|email-missing> candidate_domain=<domain|(none)>` (never the full address, FR-005) and return the exact existing literal `{ error: "Registration closed. This instance only allows one user." }` with 403 + `noCacheHeaders()` (FR-004).
- [ ] T009 [US1] Create `tests/integration/oauth-owner-allowlist.test.ts` using `fetchMock` from `cloudflare:test` (research D-6): drive GET `/api/v1/auth/github` to capture the state cookie + redirect URL, mock `https://github.com/login/oauth/access_token` and `https://api.github.com/user` + `/user/emails`, then GET the callback. Cases: allowed verified email on an empty instance → 200, `is_new_user: true`, user row created; mismatched email → 403 with body equal to the registration-closed literal and zero `users` rows. If the harness proves unstable after reasonable effort, drop this file, keep T007, and document the gap + follow-up in the PR body (research D-6 fallback).

**Checkpoint**: US1 deliverable — the bootstrap is identity-bound.

## Phase 4: User Story 2 — Existing behavior untouched (P2)

**Goal**: Unset variable, post-bootstrap logins, and linking are all unchanged.

**Independent Test**: Full existing suite stays green (no test modifications needed); added cases assert the gate's inactivity.

- [ ] T010 [US2] Extend the integration test (if T009 landed) with: variable unset → first login bootstraps any identity exactly as today (FR-001); variable set but owner already exists → a stranger's login returns the same registration-closed 403 as today (no observable change, spec US2 scenario 3). If T009 was dropped, these are covered by T007's unset/blank cases plus the untouched existing suite — note in the PR body.

## Phase 5: User Story 3 — Rejection indistinguishability (P3)

**Goal**: Allowlist rejections are byte-identical to registration-closed rejections; detail lives in logs only.

**Independent Test**: Body-equality assertion between the two rejection paths; code review confirms the log line carries domain only.

- [ ] T011 [US3] In the integration test (if T009 landed), assert the allowlist rejection body deep-equals the post-bootstrap registration-closed body (spec US3 scenario 1). If T009 was dropped, assert in T007 that the helper exposes no message material (it returns only a boolean) and verify the literal reuse by review — note in the PR body.

## Phase 6: Polish & Cross-Cutting

- [ ] T012 [P] Add a commented `ALLOWED_OWNER_EMAIL` entry under `[vars]` in `wrangler.toml` documenting activation, matching rule, and the blank-deactivates behavior (FR-008, research D-7).
- [ ] T013 [P] Update `docs/deployment-guide.md` §"Critical: First-login owner race": present `ALLOWED_OWNER_EMAIL` as the code-level mitigation (set it BEFORE first deploy), keep the log-in-immediately procedure as the baseline, and note the typo-recovery path (fix value, redeploy — nothing claimed yet) (FR-008, SC-003).
- [ ] T014 Run `npm run typecheck && npm test` (all suites green); open PR2 targeting `develop`, referencing Issue #157 and PR1.

## Dependencies

- T001 → T002 → T003 (strict commit order, Constitution I)
- PR1 merge gates everything below
- T004, T005, T006 independent of each other ([P]); T005 blocks T007 and T008; T004+T006 block T008/T009 type-wise
- T008 blocks T009/T010/T011 (the gate must exist before end-to-end cases)
- T012, T013 independent of code tasks; T014 last

## Parallel Example

After PR1 merges, on the PR2 branch:

```text
# Wave 1 (parallel): T004 src/types.ts | T005 src/utils/owner-allowlist.ts | T006 tests/env.d.ts
# Wave 2 (parallel): T007 helper unit tests | T012 wrangler.toml | T013 deployment guide
# Wave 3 (serial):   T008 gate → T009 integration harness → T010/T011 cases → T014 verify + PR
```

## Implementation Strategy

MVP = Phase 3 (US1): the pure helper + gate + its tests close the audit finding. US2 is regression assurance (zero code — only test cases), US3 is a single body-equality assertion. The fetchMock harness (T009) is the only risky item and has an explicit, pre-agreed fallback (research D-6) so it cannot block the security fix. Ship PR2 as one small PR.
