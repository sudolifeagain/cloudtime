# Tasks: Timezone-Aware Summary Bucketing

**Input**: Design documents from `/specs/065-timezone-bucketing/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Tests**: Not explicitly requested. Tests are not included.

**Organization**: Tasks follow SDD workflow (spec → generate → implement) and are grouped by user story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup (OpenAPI Spec Changes — SDD First)

**Purpose**: Update the OpenAPI schema to reflect new timezone default behavior. Per SDD, spec changes MUST come before implementation.

- [x] T001 [P] Update `timezone` parameter description to "Defaults to the authenticated user's profile timezone when omitted" in `schemas/paths/summaries/summaries.yaml`
- [x] T002 [P] Update `timezone` parameter description to "Defaults to the authenticated user's profile timezone when omitted" in `schemas/paths/stats/stats.yaml`
- [x] T003 [P] Update `timezone` parameter description to "Defaults to the authenticated user's profile timezone when omitted" in `schemas/paths/stats/status-bar.yaml`
- [x] T004 [P] Update `timezone` parameter description to "Defaults to the authenticated user's profile timezone when omitted" in `schemas/paths/stats/durations.yaml`
- [x] T005 [P] Add timezone limitation note to global stats endpoint description in `schemas/paths/meta/global-stats.yaml` — document that summary data is bucketed by the owner's profile timezone; the query `timezone` parameter only shifts the date range anchor
- [x] T006 Run `npm run generate` to regenerate `src/types/generated.ts` from updated OpenAPI schema

**Checkpoint**: OpenAPI schema updated, types regenerated. Ready for implementation.

---

## Phase 2: Foundational (Auth Context Extension)

**Purpose**: Expose the user's profile timezone in the Hono request context so all authenticated endpoints can access it.

**CRITICAL**: Must complete before US1 endpoint changes.

- [x] T007 Add `userTimezone: string` to `AuthEnv.Variables` type in `src/types.ts` (change `Variables: { userId: string }` to `Variables: { userId: string; userTimezone: string }`)
- [x] T008 Update `authMiddleware` in `src/middleware/auth.ts` to fetch the user's timezone from D1 after authentication succeeds (both API key and session paths) and set `c.set("userTimezone", timezone)`. Query: `SELECT timezone FROM users WHERE id = ?`. Default to `"UTC"` if null.

**Checkpoint**: `c.get("userTimezone")` available in all authenticated route handlers.

---

## Phase 3: User Story 1 — Accurate daily summaries in my local timezone (Priority: P1) MVP

**Goal**: Authenticated endpoints default the `timezone` query parameter to the user's profile timezone instead of UTC, ensuring "Today" and "Yesterday" align with the user's local calendar date.

**Independent Test**: Set user timezone to "Asia/Tokyo", query `/summaries?range=Today` without `?timezone=` parameter, verify the date range is anchored to JST (not UTC).

### Implementation for User Story 1

- [ ] T009 [P] [US1] Update `/summaries` handler in `src/routes/summaries.ts` — change `const tz = c.req.query("timezone")` to fall back to `c.get("userTimezone")` when the query parameter is omitted. Also update the `tz` passed to `buildSummary()` and `resolveDateRange()`.
- [x] T010 [US1] Update `/stats/:range` handler in `src/routes/stats.ts` — change `const tz = c.req.query("timezone")` to fall back to `c.get("userTimezone")`. Update `range.timezone` response field from `tz ?? "UTC"` to use the resolved timezone value.
- [x] T011 [US1] Update `/status_bar/today` handler in `src/routes/stats.ts` — change `const tz = c.req.query("timezone")` to fall back to `c.get("userTimezone")`. Update KV cache key to use resolved timezone.
- [x] T012 [US1] Update `/all_time_since_today` handler in `src/routes/stats.ts` — change `const tz = c.req.query("timezone")` to fall back to `c.get("userTimezone")`. Update `range.timezone` response field.
- [x] T013 [US1] Update `/durations` handler in `src/routes/stats.ts` — convert the `date` parameter to epoch boundaries using the user's profile timezone (not UTC). Currently `dayStart` is computed via `Date.UTC(...)` which assumes UTC boundaries. Use `getDateForTimestamp`-style timezone conversion, or compute the epoch start/end of the given date in the user's timezone using `Intl.DateTimeFormat`. Also update the `timezone` response field from hardcoded `"UTC"` to the resolved timezone.
- [x] T014 [US1] Run `npx tsc --noEmit` to verify no type errors after all route handler changes

**Checkpoint**: All authenticated endpoints default to user's profile timezone. Cron bucketing (already correct) and query time align.

---

## Phase 4: User Story 2 — Set my timezone in my profile (Priority: P1)

**Goal**: Verify that timezone validation and persistence already work correctly. No new code needed — US2 is already implemented.

**Independent Test**: `PATCH /api/v1/users/current/profile` with `{"timezone": "Asia/Tokyo"}` succeeds; `{"timezone": "Mars/Olympus"}` returns 400.

### Verification for User Story 2

- [x] T015 [US2] Verify timezone validation in `src/routes/users.ts` — confirm `validateProfileInput()` correctly validates IANA timezone strings via `Intl.DateTimeFormat` (lines 71-77). Confirm invalid timezones return a 400 error. No code changes expected.
- [x] T016 [US2] Verify timezone persistence — confirm `PATCH /profile` handler writes `timezone` to D1 and returns it in the response via `rowToUser()`. Confirm `users.timezone` column defaults to `'UTC'` in `src/db/schema.sql` (line 12). No code changes expected.

**Checkpoint**: Profile timezone setting confirmed working. FR-002, FR-003 satisfied.

---

## Phase 5: User Story 3 — Document global stats timezone limitation (Priority: P2)

**Goal**: Document that global stats uses UTC default and that summary data bucketing depends on the user's profile timezone.

**Independent Test**: Verify `docs/timezone-behavior.md` exists and accurately describes the behavior.

### Implementation for User Story 3

- [x] T017 [US3] Create `docs/timezone-behavior.md` — document: (1) authenticated endpoints default to user's profile TZ, (2) global stats defaults to UTC, (3) summaries are bucketed by profile TZ at cron time, (4) changing timezone does not re-bucket existing summaries, (5) known limitation for multi-user mode deferred to Milestone 4. Reference Issues #28 and #29.

**Checkpoint**: Timezone behavior documented. FR-006 satisfied. Issue #29 addressed.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation and cleanup.

- [x] T018 Run `npx tsc --noEmit` to verify full project compiles without type errors
- [x] T019 Run quickstart.md manual validation — test the verification steps from `specs/065-timezone-bucketing/quickstart.md`. Additionally verify: (1) DST-observing timezone (e.g., America/New_York) correctly shifts day boundaries near DST transition (FR-004), (2) changing user timezone does not alter previously aggregated summary dates (FR-007)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup/Schema)**: No dependencies — start immediately
- **Phase 2 (Foundational)**: Depends on T006 (type generation) for type consistency
- **Phase 3 (US1)**: Depends on Phase 2 (T008 — `userTimezone` in context)
- **Phase 4 (US2)**: No dependencies — verification only, can run in parallel with Phase 2+3
- **Phase 5 (US3)**: No dependencies — documentation only, can run in parallel with any phase
- **Phase 6 (Polish)**: Depends on Phases 3, 4, 5 completion

### User Story Dependencies

- **US1 (P1)**: Depends on Phase 2 (auth context). Core MVP.
- **US2 (P1)**: Independent — verification only. Already implemented.
- **US3 (P2)**: Independent — documentation only.

### Within User Story 1

- T009 (`summaries.ts`) can run in parallel with the stats.ts group (T010–T012)
- T010, T011, T012 must be sequential (same file `stats.ts`)
- T013 must be done carefully (durations epoch boundary change is more involved)
- T014 validates everything compiled correctly

### Parallel Opportunities

```
Phase 1: T001 ║ T002 ║ T003 ║ T004 ║ T005  (all parallel — different files)
              ↓
         T006  (sequential — depends on all schema changes)
              ↓
Phase 2: T007 → T008  (sequential — type def before middleware)
              ↓
Phase 3: T009 ║ (T010 → T011 → T012)  (T009 parallel with stats.ts group; stats.ts tasks sequential — same file)
                    ↓
         T013 → T014  (sequential — durations fix, then type check)

Phase 4: T015 ║ T016  (parallel with any phase — verification only)
Phase 5: T017  (parallel with any phase — docs only)
Phase 6: T018 → T019  (sequential — after all implementation)
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1: OpenAPI schema updates + type generation
2. Complete Phase 2: Auth context extension (T007, T008)
3. Complete Phase 3: Route handler defaults (T009–T014)
4. **STOP and VALIDATE**: Query `/summaries?range=Today` without `?timezone=` — should use profile TZ
5. Deploy/demo if ready

### Incremental Delivery

1. Phase 1 + Phase 2 → Foundation ready
2. Add US1 → Test → Deploy (MVP — Issue #28 resolved)
3. Add US2 → Verify (already working — confirmation step)
4. Add US3 → Documentation → Deploy (Issue #29 addressed)
5. Phase 6 → Final validation

### PR Structure (per CLAUDE.md SpecKit 2-PR Workflow)

- **PR1 (Spec + Design)**: T001–T006 (OpenAPI changes + type generation) + speckit artifacts
- **PR2 (Implementation)**: T007–T019 (middleware, route handlers, docs). Only after PR1 merged.

---

## Notes

- Cron aggregation (`src/cron/aggregate.ts`) already uses user's profile timezone — no changes needed
- Profile timezone validation (`src/routes/users.ts`) already implemented — US2 is verification only
- Global stats (`src/routes/meta.ts`) stays UTC default — no code changes, only documentation
- [P] tasks = different files, no dependencies
- Commit after each task or logical group
- Total: 19 tasks across 6 phases
