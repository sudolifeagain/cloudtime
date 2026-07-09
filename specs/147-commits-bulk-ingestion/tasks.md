# Tasks: Bulk commit ingestion

**Branch**: `147-commits-bulk-ingestion`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Generated**: 2026-07-09 · **Issue**: #147

## PR1 — Spec + Design

- [ ] **T-001**: Author `spec.md` (US1 bulk create+read, US2 all-or-nothing validation, US3 idempotent re-post; FR-001..FR-011; edge cases; SC-001..SC-006).
- [ ] **T-002**: Author `plan.md` (Constitution Check; thin handler mirroring `external_durations.bulk`; single `db.batch()`; no schema change; no correlation).
- [ ] **T-003**: Author `research.md` (D-1 `.bulk` bare array, D-2 all-or-nothing + single `db.batch()`, D-3 no heartbeat correlation, D-4 cap 100, D-5 in-batch idempotency, D-6 reuse validator/upsert).
- [ ] **T-004**: Author `data-model.md` (no schema change; array request; per-element mapping; single `db.batch()` write; untouched aggregates).
- [ ] **T-005**: Author `quickstart.md` (scenarios A–I).
- [ ] **T-006**: Author `contracts/openapi-diff.md` (additive `commits-bulk.yaml` path + registration; description-only `CommitInput.total_seconds` reword).
- [ ] **T-007**: Author `checklists/requirements.md`.
- [ ] **T-008**: Add `schemas/paths/commits/commits-bulk.yaml` — `post` (`createProjectCommitsBulk`): `project` path param; array `CommitInput` body `maxItems: 100`; `201 { data: Commit[] }`; `400`; `401`.
- [ ] **T-009**: Register `/users/current/projects/{project}/commits.bulk` in `schemas/openapi.yaml` under `# --- commits ---`; reword `schemas/components/schemas/CommitInput.yaml` `total_seconds` description to be endpoint-neutral (single derives / bulk stores absent).
- [ ] **T-010**: Run `npm run lint:api`; `npm run generate` (expect additive `createProjectCommitsBulk` + the new path member, and the `CommitInput` JSDoc description change — no other member/shape change); `npm run typecheck`. Review the `src/types/generated.ts` diff.
- [ ] **T-011**: Commit PR1 in SDD order (SpecKit + schemas, then regenerated types), push, open PR against `develop` referencing #147.

## PR2 — Implementation (after PR1 merges)

- [ ] **T-101**: `src/routes/commits.ts` — add the `POST /projects/:project/commits.bulk` handler under `authMiddleware`, mirroring `external_durations.bulk`: parse JSON → reject non-array (`400`) / over-100 (`400`) → validate every element with the existing `validateCommitInput` (`400 item {i}: {message}` on first failure, nothing written) → empty array → `201 { data: [] }` → one `db.batch()` of the upsert bound per element → shape via `rowToCommit` → `201 { data: Commit[] }`. Extract a shared `commitUpsertStmt(db, userId, project, v)` (behavior-preserving; the single POST binds it too) and reuse the existing `UPSERT_SQL`/`SELECT_COLUMNS`/`rowToCommit`. Register the route + its `authMiddleware` line. File header updated. **No correlation query in the bulk path** (FR-005, FR-011).
- [ ] **T-102a**: Unit tests `tests/aggregation/commit-input.test.ts` (extend) — assert the array-level guards a bulk handler relies on: non-array rejected, over-cap rejected, first-invalid-element index reported, empty array yields no statements. (Keep pure — no D1.)
- [ ] **T-102b**: Integration tests `tests/integration/commits.test.ts` (extend) — bulk create + read-back (order preserved), all-or-nothing 400 (mid-batch bad element leaves nothing written), non-array 400, over-100 400, empty array `201 { data: [] }`, omitted `total_seconds` → `"0 secs"` with **no** correlation even when heartbeats surround the commit, idempotent re-post across batches (single row), in-batch duplicate last-wins, `project` from path, cross-user isolation, 401 before validation, aggregates (`summaries`/`user_projects`) untouched.
- [ ] **T-103**: `npm run typecheck` — zero errors.
- [ ] **T-104**: `npm test` — full suite green incl. new unit + integration.
- [ ] **T-105**: Commit with `feat:` prefix, push, open PR against `develop` referencing PR1 and issue #147 (`Closes #147`).

## Dependencies

```
T-001 .. T-010 → T-011                  (PR1)
T-011 → T-101 .. T-105                   (PR2 after PR1 merge)
T-101 → T-102 → T-103 → T-104 → T-105
```

## Out of scope

- **Server-side `total_seconds` correlation in bulk** (research D-3) — deferred. A follow-up *shared-window batch correlation* (one heartbeat read over the union window, per-commit attribution in memory) is the natural enhancement, tracked as a future issue; the single endpoint (#145) still correlates.
- Git-host webhook receiver / signature verification (#146) — a separate provider-facing adapter that can translate a push into this bulk array.
- Any change to `summaries` / `hourly_summaries` / `user_projects` or the read endpoints' contract.
- Any change to the single-commit endpoint's behavior (#135/#145) — untouched.
