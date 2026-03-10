# Tasks: Heartbeat Spec WakaTime-compatible CLI Compatibility

**Input**: Design documents from `/specs/001-heartbeat-spec-compat/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Not requested — test tasks are omitted.

**Organization**: Tasks are grouped by user story. Per CLAUDE.md SDD rules, the SpecKit 2-PR workflow applies: PR1 = spec + types (no implementation), PR2 = implementation (after PR1 merges).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: No new project setup needed — existing repo structure is sufficient. This phase covers only the prerequisite spec research verification.

- [x] T001 Verify existing schema files are present and baseline is correct: `schemas/components/schemas/Category.yaml`, `schemas/components/schemas/HeartbeatInput.yaml`, `schemas/components/schemas/Heartbeat.yaml`, `schemas/paths/heartbeats/heartbeats.yaml`, `schemas/paths/heartbeats/heartbeats-bulk.yaml`

---

## Phase 2: OpenAPI Spec Updates (PR1 — Spec + Types)

**Purpose**: Update the OpenAPI spec and regenerate types. This entire phase is a single PR targeting `develop`. No implementation code.

**⚠️ CRITICAL**: All spec changes must be committed before any implementation. Commit order: spec changes → `npm run generate` → commit generated types.

### Spec Schema Changes

- [x] T002 [P] Update `schemas/components/schemas/Category.yaml` — add 5 new enum values: `advising`, `meeting`, `planning`, `supporting`, `translating` (total: 21)
- [x] T003 [P] Update `schemas/components/schemas/HeartbeatInput.yaml` — expand `type` enum to add `url`, `event`; change `dependencies` to accept `oneOf: [string, array of strings]`; add optional `machine` (string) and `user_agent` (string) fields
- [x] T004 [P] Update `schemas/components/schemas/Heartbeat.yaml` — add optional response fields: `start` (number/double), `end` (number/double), `timezone` (string)
- [x] T005 [P] Create `schemas/components/schemas/HeartbeatBulkItem.yaml` — new schema with `data` (`{id: string}` or null) and `error` (string or null) fields
- [x] T006 [P] Create `schemas/components/parameters/MachineNameHeader.yaml` — `X-Machine-Name` header parameter (optional, string)
- [x] T007 [P] Create `schemas/components/parameters/UserAgentHeader.yaml` — `User-Agent` header parameter (optional, string)

### Spec Path Updates

- [x] T008 Update `schemas/paths/heartbeats/heartbeats.yaml` — add `MachineNameHeader` and `UserAgentHeader` parameters to POST operation; reference updated `HeartbeatInput`; ensure GET response references updated `Heartbeat` with `start`/`end`/`timezone`
- [x] T009 Update `schemas/paths/heartbeats/heartbeats-bulk.yaml` — change response schema to use `HeartbeatBulkItem` in `[HeartbeatBulkItem, integer]` tuple format; add `MachineNameHeader` and `UserAgentHeader` parameters to POST operation

### Spec Assembly & Type Generation

- [x] T010 Update `schemas/openapi.yaml` root file to reference new component schemas (`HeartbeatBulkItem`) and parameters (`MachineNameHeader`, `UserAgentHeader`) if not auto-discovered
- [x] T011 Run `npm run generate` to regenerate `src/types/generated.ts` and verify no type errors with `npx tsc --noEmit`

**Checkpoint**: PR1 ready — spec changes + regenerated types. Create PR targeting `develop`. No implementation code in this PR.

---

## Phase 3: User Story 1 — Editor plugin sends heartbeats with full metadata (Priority: P1) 🎯 MVP

**Goal**: Accept all WakaTime-compatible CLI fields (expanded type/category enums, machine, user_agent, dependencies as array or string) without rejecting valid heartbeats.

**Independent Test**: POST a heartbeat with `type: "url"`, `category: "meeting"`, `machine: "my-laptop"`, `user_agent: "wakatime/v1.90.0"`, `dependencies: ["react", "lodash"]` — verify 201 with stored data.

### Implementation for User Story 1 (PR2)

- [ ] T012 [US1] Update `VALID_TYPES` set in `src/routes/heartbeats.ts` to include `url` and `event` (total: 5 values)
- [ ] T013 [US1] Add `VALID_CATEGORIES` set in `src/routes/heartbeats.ts` with all 21 category values and add category validation to `validateHeartbeatInput()`
- [ ] T014 [US1] Add dependencies normalization logic in `src/routes/heartbeats.ts` — if `dependencies` is a string, split on commas and trim whitespace; if array, use as-is; serialize as JSON string for DB storage. Apply in both single POST and bulk POST paths before `bindHeartbeatParams`
- [ ] T015 [US1] Update `machine` resolution in `src/routes/heartbeats.ts` — body `machine` field takes priority over `X-Machine-Name` header; update single POST and bulk POST handlers
- [ ] T016 [US1] Add `user_agent` resolution in `src/routes/heartbeats.ts` — body `user_agent` field takes priority over `User-Agent` header; pass resolved value to `bindHeartbeatParams` (store in `user_agent_id` column or new column as appropriate)
- [ ] T017 [US1] Update `bindHeartbeatParams()` in `src/routes/heartbeats.ts` to accept and bind normalized `dependencies` (JSON string) and resolved `user_agent` value
- [ ] T018 [US1] Validate with manual curl test: POST single heartbeat with all new fields populated, verify 201 and correct storage

**Checkpoint**: US1 complete — editor plugins can send heartbeats with full WakaTime-compatible CLI field set.

---

## Phase 4: User Story 2 — Bulk heartbeat submission returns compatible response (Priority: P1)

**Goal**: Bulk POST returns `[{data: {id}, error}, code]` tuples instead of full `[Heartbeat, code]` tuples. Invalid items return per-item errors instead of rejecting entire batch.

**Independent Test**: POST 3 heartbeats (2 valid, 1 invalid) to `/heartbeats.bulk`, verify response has 3 tuples with correct `[HeartbeatBulkItem, code]` format.

### Implementation for User Story 2 (PR2)

- [ ] T019 [US2] Refactor bulk POST validation in `src/routes/heartbeats.ts` — remove early-return-all-on-any-error; validate each heartbeat independently and track per-item validation results
- [ ] T020 [US2] Update bulk POST insert logic in `src/routes/heartbeats.ts` — only insert valid heartbeats via `db.batch()`; skip invalid ones
- [ ] T021 [US2] Update bulk POST response construction in `src/routes/heartbeats.ts` — build `responses` array as `[HeartbeatBulkItem, number][]` where `HeartbeatBulkItem = {data: {id} | null, error: string | null}`; valid items get `[{data: {id}, error: null}, 201]`, invalid items get `[{data: null, error: "..."}, 400]`
- [ ] T022 [US2] Validate with manual curl test: POST bulk with mix of valid and invalid heartbeats, verify per-item response format

**Checkpoint**: US2 complete — WakaTime-compatible CLI can parse bulk responses without retry loops.

---

## Phase 5: User Story 3 — Querying heartbeats returns enriched response (Priority: P2)

**Goal**: GET /heartbeats returns `start`, `end`, and `timezone` fields for each heartbeat, computed at query time.

**Independent Test**: Create heartbeats at t=100, t=200 (within 15min), t=2000 (gap > 15min). GET them and verify `start`/`end`/`timezone` values.

### Implementation for User Story 3 (PR2)

- [ ] T023 [US3] Add session timeout constant (`SESSION_TIMEOUT_SECONDS = 900`) in `src/routes/heartbeats.ts`
- [ ] T024 [US3] Update `rowToHeartbeat()` (or create enrichment function) in `src/routes/heartbeats.ts` to accept next heartbeat's time and compute `start` (= `time`), `end` (= next heartbeat's `time` if gap ≤ 15 min, else = `start`), and `timezone` (default to user's timezone or `"UTC"`)
- [ ] T025 [US3] Update GET `/heartbeats` handler in `src/routes/heartbeats.ts` to iterate results in order and pass each heartbeat + next heartbeat's time to the enrichment function
- [ ] T026 [US3] Validate with manual curl test: query heartbeats for a date and verify `start`, `end`, `timezone` fields are present and correctly computed

**Checkpoint**: US3 complete — dashboards see enriched heartbeat data with time ranges.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation across all user stories

- [ ] T027 [P] Run `npx tsc --noEmit` to verify all type checks pass in `src/routes/heartbeats.ts`
- [ ] T028 Run full quickstart.md verification: execute all 3 curl commands from `specs/001-heartbeat-spec-compat/quickstart.md` and verify expected responses
- [ ] T029 [P] Verify edge cases from spec.md: comma-separated dependencies string normalization, unknown category/type rejection (400), absent `X-Machine-Name` header (machine = null), bulk >25 items rejected

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — can start immediately
- **Phase 2 (OpenAPI Spec)**: Depends on Phase 1 — produces PR1
- **Phase 3–5 (User Stories)**: Depend on Phase 2 (PR1 must be merged first) — produces PR2
- **Phase 6 (Polish)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Phase 2 (PR1 merge). No dependencies on other stories.
- **User Story 2 (P1)**: Can start after Phase 2 (PR1 merge). Shares `src/routes/heartbeats.ts` with US1 — execute sequentially after US1 to avoid merge conflicts.
- **User Story 3 (P2)**: Can start after Phase 2 (PR1 merge). Modifies GET handler only — can be done in parallel with US1/US2 in theory, but sequential after US2 is safer since all modify the same file.

### Within Each User Story

- Validation logic before insert logic
- Insert logic before response construction
- Core implementation before manual testing task

### Parallel Opportunities

- All T002–T007 (spec schema changes) can run in parallel — different files
- T027 and T029 (polish phase) can run in parallel
- T012 and T013 modify the same file but different sections — could be parallel with care

---

## Parallel Example: Phase 2 (Spec Changes)

```bash
# All schema updates can run in parallel (different files):
T002: Update Category.yaml
T003: Update HeartbeatInput.yaml
T004: Update Heartbeat.yaml
T005: Create HeartbeatBulkItem.yaml
T006: Create MachineNameHeader.yaml
T007: Create UserAgentHeader.yaml

# Then sequentially:
T008: Update heartbeats.yaml (references T005, T006, T007)
T009: Update heartbeats-bulk.yaml (references T005, T006, T007)
T010: Update openapi.yaml root
T011: npm run generate
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup verification
2. Complete Phase 2: OpenAPI spec + type generation (PR1)
3. **MERGE PR1** into `develop`
4. Complete Phase 3: User Story 1 (PR2 starts)
5. **STOP and VALIDATE**: Test with curl — new fields accepted
6. Can ship as minimal PR2 with just US1

### Incremental Delivery

1. Phase 2 → PR1 (spec + types) → Merge
2. US1 → Test → US2 → Test → US3 → Test → PR2 (implementation) → Merge
3. Each story adds compatibility without breaking previous stories

### PR Structure (per CLAUDE.md SpecKit 2-PR Workflow)

- **PR1**: T001–T011 (spec + types, no implementation)
- **PR2**: T012–T029 (implementation, after PR1 merges)

---

## Notes

- All implementation changes are in a **single file**: `src/routes/heartbeats.ts`
- No database migration needed — existing columns and TEXT types accommodate all changes
- No new npm dependencies required
- `dependencies` normalization is the only data transformation — all other changes are validation expansion or response reshaping
- Per CLAUDE.md: PRs target `develop`, never `master`
