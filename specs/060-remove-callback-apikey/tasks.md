# Tasks: Remove API Key from OAuth Callback Response

**Input**: Design documents from `/specs/060-remove-callback-apikey/`
**Prerequisites**: plan.md, spec.md, research.md, contracts/

**Tests**: Not requested — test tasks are omitted.

**Organization**: Tasks are grouped by SpecKit 2-PR workflow. Per CLAUDE.md SDD rules, PR1 = spec + types (no implementation), PR2 = implementation (after PR1 merges).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Verify existing files and baseline.

- [x] T001 Verify existing spec file is present and baseline is correct: `schemas/paths/auth/provider-callback.yaml`

---

## Phase 2: OpenAPI Spec Updates (PR1 — Spec + Types)

**Purpose**: Update the OpenAPI spec and regenerate types. This entire phase is a single PR targeting `develop`. No implementation code.

**CRITICAL**: All spec changes must be committed before any implementation. Commit order: spec changes → `npm run generate` → commit generated types.

### Spec Changes

- [x] T002 [P] Remove `api_key` property from the `200` response schema in `schemas/paths/auth/provider-callback.yaml`
- [x] T003 [P] Update the `description` field in `schemas/paths/auth/provider-callback.yaml` to remove the paragraph about returning the API key on first-time user creation (line 62: "On first-time user creation, the response includes...")

### Type Generation

- [x] T004 Run `npm run generate` to regenerate `src/types/generated.ts` and verify no type errors with `npx tsc --noEmit`

**Checkpoint**: PR1 ready — spec changes + regenerated types. Create PR targeting `develop`. No implementation code in this PR.

---

## Phase 3: User Story 1 — OAuth callback no longer exposes API key (Priority: P1)

**Goal**: Remove the `api_key` field from the new-user response in the OAuth callback handler. The API key is still generated and stored as a hash, but the plaintext is discarded.

**Independent Test**: Complete an OAuth login flow as a new user and verify the callback response does NOT contain an `api_key` field.

### Implementation for User Story 1 (PR2)

- [x] T005 [US1] Remove `api_key: apiKeyPlaintext` from the new-user response object in `src/routes/auth/login.ts` (the response at the end of the new-user creation path)
- [x] T006 [US1] Remove the `apiKeyPlaintext` variable usage from the response — keep the `generateApiKey()` call and hash storage, only remove the plaintext from the returned JSON
- [x] T007 [US1] Run `npx tsc --noEmit` to verify type checks pass after removing `api_key` from the response

**Checkpoint**: US1 complete — OAuth callback no longer exposes API key in any response scenario.

---

## Phase 4: Polish & Cross-Cutting Concerns

**Purpose**: Final validation.

- [x] T008 Verify the `POST /auth/api-key` endpoint still works correctly for key regeneration (no changes expected, just confirm)
- [x] T009 Run `npx tsc --noEmit` to verify all type checks pass

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — can start immediately
- **Phase 2 (OpenAPI Spec)**: Depends on Phase 1 — produces PR1
- **Phase 3 (User Story 1)**: Depends on Phase 2 (PR1 must be merged first) — produces PR2
- **Phase 4 (Polish)**: Depends on Phase 3

### Within Phase 2

- T002 and T003 can run in parallel (both modify `provider-callback.yaml` but different sections)
- T004 must run after T002 and T003

### PR Structure (per CLAUDE.md SpecKit 2-PR Workflow)

- **PR1**: T001–T004 (spec + types, no implementation)
- **PR2**: T005–T009 (implementation, after PR1 merges)

---

## Implementation Strategy

### MVP First

1. Complete Phase 1: Setup verification
2. Complete Phase 2: OpenAPI spec + type generation (PR1)
3. **MERGE PR1** into `develop`
4. Complete Phase 3: User Story 1 (PR2)
5. **STOP and VALIDATE**: Verify `api_key` is absent from callback response
6. Complete Phase 4: Polish

### PR Structure

- **PR1**: T001–T004 (spec + types, no implementation)
- **PR2**: T005–T009 (implementation, after PR1 merges)

---

## Notes

- Implementation changes are in a **single file**: `src/routes/auth/login.ts`
- Spec changes are in a **single file**: `schemas/paths/auth/provider-callback.yaml`
- No database migration needed
- No new npm dependencies required
- Per CLAUDE.md: PRs target `develop`, never `master`
