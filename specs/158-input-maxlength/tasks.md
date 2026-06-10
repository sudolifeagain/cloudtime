# Tasks: Maximum lengths on write-input fields

**Input**: Design documents from `specs/158-input-maxlength/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/openapi-diff.md, quickstart.md

**Organization**: Phase 1 is PR1 (this branch — contract only); Phases 2+ are PR2 (enforcement, after PR1 merges). Tests are included per the spec's Independent Test criteria and the project testing baseline.

## Phase 1: Setup — PR1, contract only (this branch)

**Goal**: Land the documented caps (data-model.md table) with zero behavior change.

- [ ] T001 Apply `specs/158-input-maxlength/contracts/openapi-diff.md` to the four schemas: `schemas/components/schemas/HeartbeatInput.yaml`, `CommitInput.yaml`, `ExternalDurationInput.yaml`, `CustomRuleInput.yaml` (maxLength/maxItems values from data-model.md). Run `npm run lint:api`. Commit the spec change on its own.
- [ ] T002 Run `npm run generate`; verify via `git diff src/types/generated.ts` that the diff is empty or JSDoc-only (openapi-typescript does not encode maxLength). Commit any regenerated output separately.
- [ ] T003 Run `npm run typecheck`; push branch `158-input-maxlength` and open PR1 targeting `develop`, referencing Issue #158 ("spec + types only, enforcement in PR2").

**Checkpoint**: PR1 open and green. Phases below start after PR1 merges, on a fresh branch off `develop`.

## Phase 2: Foundational — PR2 prerequisite (blocking all user stories)

- [ ] T004 Create `src/utils/input-limits.ts`: exported `INPUT_LIMITS` constants matching data-model.md exactly (heartbeat entity 4096; name-like 255; userAgent 512; dependenciesString 8192; dependenciesItems 100; dependencyName 255; commit hash 64 / message 4096 / name 255 / email 254 / ref 255 / url 2048; externalId 255; meta 8192; ruleValue 1024) plus a `tooLong(value, cap)` helper. Include a doc comment pointing at the four schema files as the contract source (FR-007, research R-6).

## Phase 3: User Story 1 — Oversized body fields rejected (P1) 🎯 MVP

**Goal**: Every capped body field rejects at cap+1 with the endpoint's existing 400 format.

**Independent Test**: Unit boundary tests per validator + heartbeat single/bulk integration cases.

- [ ] T005 [US1] Enforce caps in `validateHeartbeatInput` (`src/routes/heartbeats.ts`): entity/project/branch/language/editor/operating_system/machine/user_agent body fields; dependencies string ≤8192 pre-split, array ≤100 items, each item ≤255 (validate the normalized items for both forms). Error strings in the existing voice ("entity must be at most 4096 characters").
- [ ] T006 [P] [US1] Enforce caps in `src/utils/commit-input.ts` (hash/message/names/emails/ref/url) using `INPUT_LIMITS`.
- [ ] T007 [P] [US1] Enforce caps in `src/utils/external-duration-input.ts` (external_id/entity/project/branch/language/meta) using `INPUT_LIMITS`.
- [ ] T008 [P] [US1] Enforce caps in `src/utils/custom-rule-input.ts` (source_value/destination_value ≤1024) using `INPUT_LIMITS`.
- [ ] T009 [P] [US1] Create `tests/security/input-limits.test.ts`: pin every `INPUT_LIMITS` constant to its documented value (FR-007) and cover `tooLong` (at cap → false; cap+1 → true).
- [ ] T010 [US1] Add boundary cases to the validator unit tests (`tests/aggregation/commit-input.test.ts`, `tests/aggregation/external-duration-input.test.ts`, `tests/aggregation/custom-rules.test.ts`): one at-cap accept + one over-cap reject per representative field.
- [ ] T011 [US1] Add integration cases to `tests/integration/heartbeats.test.ts`: single POST with >4096 entity → 400 naming the field, nothing stored; bulk POST mixing one oversized item with valid ones → per-item 400 + valid items persisted (existing partial-failure shape); dependencies >100 items → 400.

## Phase 4: User Story 2 — Legitimate clients unaffected (P2)

**Goal**: Existing corpus passes unmodified; at-cap values accepted.

- [ ] T012 [US2] Verify the full pre-existing suite passes with zero test-file modifications other than additions (SC-002), and include at-cap acceptance cases (entity exactly 4096, project exactly 255) in the T011 integration additions (FR-003).

## Phase 5: User Story 3 — Ambient headers truncate (P3)

**Goal**: Oversized User-Agent / X-Machine-Name headers never fail a heartbeat; stored values are capped prefixes.

- [ ] T013 [US3] Truncate in `src/utils/user-agent.ts` `resolveUserAgentId`: slice `value` to `INPUT_LIMITS.userAgent` before cache lookup/parse/upsert (covers header path; body path already validated).
- [ ] T014 [US3] Truncate the header-sourced machine value in `src/routes/heartbeats.ts` (single + bulk paths) to `INPUT_LIMITS` name cap before `machineUpsertStmt`/insert binding.
- [ ] T015 [US3] Integration cases in `tests/integration/heartbeats.test.ts`: >512-char User-Agent header → 201 and stored `user_agents.value` length 512; >255-char X-Machine-Name header → 201 and stored `machine_names.value` length 255; oversized **body** user_agent/machine → 400 (US1 contrast case).

## Phase 6: Polish & Cross-Cutting

- [ ] T016 Run `npm run typecheck && npm test`; open PR2 targeting `develop`, referencing Issue #158 and PR1.

## Dependencies

- T001 → T002 → T003 (commit order, Constitution I); PR1 merge gates the rest
- T004 blocks T005–T009 (constants module)
- T005 blocks T011/T015 (heartbeat validator first); T006/T007/T008/T009 parallel
- T013/T014 independent of T005–T012 once T004 lands
- T016 last

## Parallel Example

```text
# After T004:
Wave 1: T005 heartbeats | T006 commit-input | T007 external-duration | T008 custom-rule | T009 parity test
Wave 2: T010 unit boundaries | T011 integration 400s | T013 UA truncation | T014 machine truncation
Wave 3: T012 corpus check + T015 truncation integration → T016
```

## Implementation Strategy

MVP = Phase 3 (US1): caps enforced everywhere a body can write. US2 is regression assurance (zero code), US3 is the truncation refinement. Ship PR2 as one focused PR; the constants module keeps the whole change reviewable against the data-model table.
