# Tasks: Verify Existing User Email Before Creating PendingLink

**Input**: Design documents from `/specs/064-verify-email-pending-link/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Tests**: Not explicitly requested. Test tasks are omitted.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (SDD Schema First)

**Purpose**: Update the OpenAPI schema and regenerate types per SDD workflow (Constitution Principle I)

- [x] T001 Add `email_verified` boolean property to User schema in `schemas/openapi.yaml` (after `email` property, type: boolean, not required)
- [x] T002 Run `npm run generate` and verify `email_verified` appears in `src/types/generated.ts`

---

## Phase 2: Foundational (DB Migration + Provider Utility)

**Purpose**: Database schema change and shared utility that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T003 [P] Add `email_verified INTEGER NOT NULL DEFAULT 0` column to `users` table definition in `src/db/schema.sql`
- [x] T004 [P] Create D1 migration via `npx wrangler d1 migrations create cloudtime-db "add_email_verified"` (auto-creates `migrations/` dir and numbered file), then write ALTER TABLE + backfill UPDATE (set `email_verified = 1` for users with existing oauth_accounts). Note: ALTER TABLE ADD COLUMN with NOT NULL DEFAULT is O(1) on SQLite — no row rewriting.
- [x] T005 [P] Create provider email extraction utility in `src/utils/oauth-providers.ts` — normalize email_verified from each provider's response format: GitHub (`GET /user/emails` → find primary email's `verified` field), Google (handle BOTH `verified_email` from v2 API AND `email_verified` from OIDC endpoint; also handle string `"true"` from ID tokens), Discord (`verified` field — absent/`undefined` without `email` scope, treat as `false`). Return `false` if field is absent or undefined.

**Checkpoint**: Schema, migration, and provider utility ready. User story implementation can begin.

---

## Phase 3: User Story 1 — Record Email Verification Status (Priority: P1) MVP

**Goal**: When a user signs up or logs in via OAuth, their `email_verified` status is recorded/updated based on the provider's response.

**Independent Test**: Create a new user via OAuth → check D1 `users.email_verified` matches provider's report. Log in again with a verified email → verify the value is upgraded to true. Log in again with an unverified email → verify the value remains true (high-water mark: upgrades only, no downgrades).

### Implementation for User Story 1

- [x] T006 [US1] In the OAuth callback handler (`src/routes/auth.ts` or equivalent), call the provider utility from T005 to extract `email_verified` from the provider's user info response
- [x] T007 [US1] On new user creation (callback path c: new email → new user), set `email_verified` on the INSERT statement based on provider's reported value
- [x] T008 [US1] On existing user login (callback path a: oauth_account exists), upgrade `users.email_verified` to true if the provider reports verified. Never downgrade (high-water mark: `UPDATE users SET email_verified = 1 WHERE id = ? AND email_verified = 0` only when provider reports verified)

**Checkpoint**: All new and returning OAuth users have accurate `email_verified` values in D1.

---

## Phase 4: User Story 2 — Gate PendingLink on Email Verification (Priority: P1)

**Goal**: In multi-user mode, PendingLink is only created when BOTH the existing user's email is verified AND the incoming provider reports a verified email. Otherwise, a new account is created instead.

**Independent Test**: OAuth login with email matching existing user → PendingLink created only if both emails verified. If either is unverified → new account created instead.

### Implementation for User Story 2

- [x] T009 [US2] In the OAuth callback same-email detection logic (callback path b: no oauth_account + email matches existing user), add dual verification check: query `users.email_verified` for the existing user AND check provider's `email_verified` from T005. When matching by email, use `ORDER BY created_at ASC LIMIT 1` to deterministically select the oldest user if duplicates exist.
- [x] T010 [US2] If both are verified → create PendingLink (existing behavior). If either is unverified → fall through to new user creation (callback path c) instead of creating PendingLink

**Checkpoint**: PendingLink creation is now gated by dual email verification in multi-user mode.

---

## Phase 5: User Story 3 — Single-User Mode Bypass (Priority: P2)

**Goal**: In single-user mode, provider linking continues to work directly without email verification gate. The `email_verified` field is still recorded accurately.

**Independent Test**: In single-user mode, sign in with a second OAuth provider → provider linked directly to owner regardless of email verification status. Verify `email_verified` is still set correctly on the user record.

### Implementation for User Story 3

- [x] T011 [US3] Verify that the single-user mode code path (direct linking without PendingLink) is not affected by the dual verification gate from T009/T010. The gate should only apply when `INSTANCE_MODE=multi` and the same-email detection path is reached. Add explicit instance mode check if needed in `src/routes/auth.ts`
- [x] T012 [US3] Ensure T007/T008 (email_verified recording) still runs in single-user mode — the field is populated regardless of instance mode

**Checkpoint**: Single-user mode works without regression. email_verified is recorded but not used as a gate.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation updates and follow-up issue creation

- [x] T013 [P] Update `docs/auth-design.md` — add email_verified to the OAuth callback flow description (section "Account Merge"), document the dual verification requirement for PendingLink creation
- [x] T014 [P] Update `docs/auth-design.md` — add note about email_verified high-water mark behavior (no downgrade) in the OAuth flow section
- [x] T015 Create GitHub issue for future work: "Add out-of-band email verification (confirmation email) for PendingLink approval" — reference Issue #39 and this feature's Out of Scope section

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 completion (generated types needed). BLOCKS all user stories.
- **User Story 1 (Phase 3)**: Depends on Phase 2 (provider utility + schema)
- **User Story 2 (Phase 4)**: Depends on Phase 2 (schema) + logically builds on US1's email_verified recording
- **User Story 3 (Phase 5)**: Depends on Phase 2 (schema) + verifies US2's gate doesn't break single-user mode
- **Polish (Phase 6)**: Depends on all user stories being complete

### User Story Dependencies

- **US1 (P1)**: Can start after Phase 2 — no dependencies on other stories
- **US2 (P1)**: Can start after Phase 2 — reads `email_verified` values set by US1, but the gate logic is independent
- **US3 (P2)**: Can start after Phase 2 — verifies non-interference with US2's gate

### Within Each User Story

- Provider utility (T005) before callback logic
- User creation path before login update path
- Core implementation before edge case handling

### Parallel Opportunities

- T003 and T004 and T005 can run in parallel (different files)
- T013 and T014 can run in parallel (different sections of same doc, or batched)
- US1 and US2 can potentially be implemented in the same callback handler pass since they touch the same code path

---

## Parallel Example: Phase 2

```text
# These three tasks touch different files and can run in parallel:
Task T003: "Add email_verified column to src/db/schema.sql"
Task T004: "Create migration file migrations/0001_add_email_verified.sql"
Task T005: "Create provider utility in src/utils/oauth-providers.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Update OpenAPI schema + regenerate types
2. Complete Phase 2: DB migration + provider utility
3. Complete Phase 3: US1 — email_verified recording
4. **STOP and VALIDATE**: Verify email_verified is correctly set on OAuth login
5. This alone provides data completeness even without the PendingLink gate

### Incremental Delivery

1. Phase 1 + Phase 2 → Foundation ready
2. Add US1 → email_verified recorded → Deploy (data-only, no behavior change)
3. Add US2 → PendingLink gated → Deploy (security improvement active)
4. Add US3 → Single-user mode verified → Deploy (regression confirmed absent)
5. Phase 6 → Docs updated, follow-up issue created

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story
- SDD commit order: T001 (schema) → T002 (generate) → T003/T004 (migration) → T006+ (implementation)
- The OAuth callback handler (`src/routes/auth.ts`) may not exist yet. Tasks T006-T012 assume it will be created as part of the broader auth implementation. If it doesn't exist, create the relevant sections within the callback handler.
- T015 (follow-up issue) fulfills the user's request to track out-of-band email verification as a separate task.
