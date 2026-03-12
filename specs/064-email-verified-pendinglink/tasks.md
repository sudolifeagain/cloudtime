# Tasks: Verify Existing User Email Before Creating PendingLink

**Input**: Design documents from `/specs/064-email-verified-pendinglink/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Not explicitly requested. Test tasks omitted.

**Organization**: Tasks follow SDD 2-PR workflow (PR1: Spec+Schema, PR2: Implementation) and are grouped by user story within each PR.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup — Spec + Schema (PR1)

**Purpose**: Update OpenAPI spec, regenerate types, update DB schema, and create migration file. Per SDD, spec changes must be committed before implementation.

- [x] T001 Add `email_verified` boolean property to User schema component in `schemas/openapi.yaml` — add to properties with `type: boolean`, `description`, and `example: true`; add to required list if one exists
- [x] T002 Run `npm run generate` to regenerate `src/types/generated.ts` — verify `email_verified` appears in the generated User type
- [x] T003 [P] Add `email_verified INTEGER NOT NULL DEFAULT 0` column to `users` CREATE TABLE statement in `src/db/schema.sql`
- [x] T004 [P] [US4] Create D1 migration file `migrations/XXXX_add_email_verified.sql` with `ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0` followed by backfill `UPDATE users SET email_verified = 1 WHERE id IN (SELECT DISTINCT user_id FROM oauth_accounts WHERE email_verified = 1)`

**Checkpoint**: PR1 ready — spec, types, schema, and migration complete. Commit and merge before PR2.

---

## Phase 2: Foundational — User Type Mapping (PR2)

**Purpose**: Update the shared user utility to include `email_verified` before modifying any route handlers.

**CRITICAL**: Must complete before any user story implementation.

- [x] T005 Add `email_verified` field to `UserRow` type and `rowToUser()` mapping function in `src/utils/user.ts` — ensure it maps `INTEGER` (0/1) to `boolean` for API responses

**Checkpoint**: Foundation ready — UserRow type includes email_verified. Route handler work can begin.

---

## Phase 3: User Stories 1, 2, 3 — Login Flow Email Verified Gating (Priority: P1) MVP

**Goal**: Gate PendingLink creation on `email_verified`, clear unverified emails, and set `email_verified = 1` on new OAuth user creation. These three stories are implemented together because they share the same code path in `login.ts`.

**Independent Test**: Create a user with unverified email → OAuth login with same email → verify no PendingLink created, old user email cleared, new user created with email. Then: create a user via OAuth (verified) → second OAuth login with same email → verify PendingLink IS created.

### Implementation

- [x] T006 [P] [US3] Modify new user creation INSERT statements (both single-user and multi-user paths) to include `email_verified` column with value `1` in `src/routes/auth/login.ts` (lines ~272 and ~305)
- [x] T007 [US1] [US2] Modify email match query from `SELECT id FROM users WHERE email = ?` to `SELECT id, email_verified FROM users WHERE email = ?` in `src/routes/auth/login.ts` (line ~167) — add conditional branch: if `email_verified = 1` proceed to PendingLink (existing flow); if `email_verified = 0` fall through to email cleanup + new user creation
- [x] T008 [US1] Implement email cleanup for unverified users in `src/routes/auth/login.ts` — when `email_verified = 0`: prepend `UPDATE users SET email = NULL, modified_at = datetime('now') WHERE id = ?` to the `db.batch()` that creates the new user + oauth_account, ensuring atomicity. Note: in single-user mode the existing guard (`WHERE (SELECT COUNT(*) FROM users) = 0`) will block the new user INSERT — the email cleanup still runs but user creation is subject to the single-user limit
- [x] T009 [US1] Add security event logging in `src/routes/auth/login.ts` — log `console.error("Security: skipping PendingLink — existing user {id} email unverified for provider {provider}")` (FR-008) and `console.error("Security: clearing unverified email {email} from user {id}")` (FR-009) before executing the batch

**Checkpoint**: Core security fix complete. PendingLink gated on email_verified, unverified emails cleared, new users get email_verified = 1. Stories 1, 2, 3 independently testable.

---

## Phase 4: FR-006 — PendingLink Approval Sets email_verified

**Goal**: When a PendingLink is approved and the linked provider has a verified email, set `email_verified = 1` on the existing user.

**Independent Test**: Approve a PendingLink from a provider with verified email → verify `users.email_verified` is now `1`.

### Implementation

- [x] T010 [P] [US2] Add `UPDATE users SET email_verified = 1, modified_at = datetime('now') WHERE id = ? AND email_verified = 0` to the existing `db.batch()` in the PendingLink approval handler in `src/routes/auth/link.ts` (line ~92) — only when `pending_link.email_verified = 1`

**Checkpoint**: PendingLink approval flow complete. Verified providers propagate email_verified to user account.

---

## Phase 5: Polish & Validation

**Purpose**: Type safety validation and final verification.

- [x] T011 Run `npx tsc --noEmit` to validate all changes compile without type errors
- [x] T012 Verify all User-returning endpoints (`/auth/session`, `/auth/{provider}/callback`, `/auth/link/approve/{id}`) include `email_verified` in response per `contracts/openapi-diff.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (Foundational)**: Depends on Phase 1 (T002 must complete for generated types)
- **Phase 3 (US1+US2+US3)**: Depends on Phase 2 (T005 must complete for UserRow type)
- **Phase 4 (FR-006)**: Depends on Phase 2 (T005). Can run in parallel with Phase 3 (different file: link.ts vs login.ts)
- **Phase 5 (Polish)**: Depends on Phases 3 and 4 completion

### User Story Dependencies

- **US1 (P1)**: Depends on foundational T005. Implemented in T007, T008, T009.
- **US2 (P1)**: Depends on foundational T005. Implemented in T007 (same conditional branch as US1) and T010 (link.ts).
- **US3 (P1)**: Depends on foundational T005. Implemented in T006. No dependency on US1/US2.
- **US4 (P2)**: No code dependency. Migration file T004 is independent (created in Phase 1).

### Within Phase 3

- T006 (US3) can start independently — modifies user creation INSERT
- T007 (US1+US2) must complete before T008 — T007 adds the conditional branch, T008 adds cleanup logic within that branch
- T009 depends on T008 — logging goes alongside the cleanup logic

### Parallel Opportunities

```text
Phase 1: T003 [P] and T004 [P] can run in parallel (different files)
Phase 3+4: T006 [US3] and T010 [US2] can run in parallel (login.ts vs link.ts)
```

---

## Parallel Example: Phase 3 + Phase 4

```bash
# These can run in parallel (different files):
Task T006: "Modify user creation INSERT in src/routes/auth/login.ts"
Task T010: "Add email_verified UPDATE to PendingLink approval in src/routes/auth/link.ts"

# These must be sequential (same file, same function):
Task T007 → Task T008 → Task T009 (all in login.ts email match flow)
```

---

## Implementation Strategy

### MVP First (Phase 1 + 2 + 3)

1. Complete Phase 1: Spec + Schema (PR1)
2. Complete Phase 2: User type mapping
3. Complete Phase 3: Login flow gating (US1+US2+US3)
4. **STOP and VALIDATE**: Type check + manual test
5. This alone delivers the core security fix (SC-001, SC-003)

### Full Delivery (add Phase 4 + 5)

6. Complete Phase 4: PendingLink approval sets email_verified (FR-006)
7. Complete Phase 5: Final validation
8. All success criteria met (SC-001 through SC-004)

### PR Structure (SDD 2-PR Workflow)

- **PR1**: T001, T002, T003, T004 (Spec + Schema + Migration)
- **PR2**: T005, T006, T007, T008, T009, T010, T011, T012 (Implementation)

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- US1/US2/US3 are tightly coupled in login.ts — implemented together in Phase 3
- US4 is covered by the migration file in T004 (Phase 1)
- Commit after each task or logical group
- Per constitution: spec changes (PR1) must merge before implementation (PR2)
