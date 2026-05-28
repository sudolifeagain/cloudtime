# Acceptance Checklist: External Durations

## PR1 (Spec) gate — must be ✅ before merging

- [x] `spec.md` covers FR-001..FR-007 (create / bulk / list / delete) with no `[NEEDS CLARIFICATION]` markers.
- [x] `spec.md` records the spec-level decisions (upsert idempotency, parallel series, bulk cap 100, all-or-nothing).
- [x] `plan.md` Constitution Check has all five principles marked PASS.
- [x] `research.md` documents the 5 design decisions.
- [x] `data-model.md` confirms no schema change and documents the upsert / list / delete statements.
- [x] `quickstart.md` enumerates scenarios A–H.
- [x] `tasks.md` separates PR1 from PR2 with dependency arrows.
- [x] `contracts/openapi-diff.md` documents the `400` additions and descriptions.
- [x] Both path files carry the new `400` responses + descriptions.
- [x] `npm run generate` adds the 400 responses + JSDoc (no body type-shape change); `npm run typecheck` passes.
- [x] PR1 contains no runtime code under `src/` (only regenerated `src/types/generated.ts`).
- [x] PR1 references issue #106.

## PR2 (Implementation) gate — must be ✅ before merging

### Code

- [ ] `src/utils/external-duration-input.ts` validates a body → normalised row | error (required fields, `type` enum, `end_time` ≥ `start_time`).
- [ ] `src/routes/external-durations.ts` implements all four handlers behind `authMiddleware`:
  - `POST /external_durations` — validate, upsert on `(user_id, external_id)`, return `201 {data}`.
  - `POST /external_durations.bulk` — validate all (≤100), `db.batch` upsert, return `201 {data[]}`; any invalid → 400, nothing written.
  - `GET /external_durations?date=` — day-scoped by `start_time` (tz), `project`/`branches` filters, `400` on missing/bad date or invalid timezone.
  - `DELETE /external_durations.bulk` — `{date, ids}`, scoped by `user_id`, `204`, `400` on bad body.
- [ ] `src/index.ts` mounts the router at `/api/v1/users/current`.
- [ ] The cron aggregator and `summaries` are **not** modified.
- [ ] `npm run typecheck` passes; no hand-edited generated types.

### Behaviour (per `quickstart.md`)

- [ ] A: single create 201; B: re-sync idempotent (no duplicate); C: validation 400s.
- [ ] D: bulk all-or-nothing; E: list day-scoped + project filter, missing date / invalid timezone 400; F: bulk delete 204 + unknown ids ignored.
- [ ] G: `/stats` unaffected; H: unauthenticated 401, cross-user isolation.

### Tests

- [ ] `tests/security/external-duration-input.test.ts` (or `tests/aggregation/`): validation rules.
- [ ] `tests/integration/external-durations.test.ts`: create/upsert, bulk all-or-nothing, list-by-day + filters, bulk delete, cross-user, 401.
- [ ] `npm test` stays green with the new coverage.

## Post-deployment gate

- [ ] Push a calendar event, re-push it, confirm a single updated row.
- [ ] Confirm `/stats` totals do not change when external durations are added.
- [ ] No 500s on the endpoints in the first 7 days.
