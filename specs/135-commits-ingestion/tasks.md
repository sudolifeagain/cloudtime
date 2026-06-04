# Tasks: Commit ingestion (write path)

**Branch**: `135-commits-ingestion`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Generated**: 2026-06-05 · **Issue**: #135

## PR1 — Spec + Design

- [x] **T-001**: Author `spec.md` (US1 create+read, US2 idempotent, US3 validation; FR-001..FR-010; edge cases; SC-001..SC-005).
- [x] **T-002**: Author `plan.md` (Constitution Check; thin upsert handler; no schema change).
- [x] **T-003**: Author `research.md` (D-1 dedicated POST, D-2 idempotent/201, D-3 client-supplied total_seconds, D-4 date handling, D-5 minimal validation/path project, D-6 single-vs-bulk).
- [x] **T-004**: Author `data-model.md` (no schema change; request→row mapping; upsert SQL; untouched aggregates).
- [x] **T-005**: Author `quickstart.md` (scenarios A–H).
- [x] **T-006**: Author `contracts/openapi-diff.md` (additive `post` + `CommitInput`).
- [x] **T-007**: Author `checklists/requirements.md`.
- [x] **T-008**: Add `schemas/components/schemas/CommitInput.yaml`.
- [x] **T-009**: Update `schemas/paths/commits/commits.yaml` — add the `post` (`createProjectCommit`) operation; note ingestion in the `get` description.
- [x] **T-010**: Run `npm run generate` (expect additive `createProjectCommit` + `CommitInput` in `src/types/generated.ts`); run `npm run typecheck`.
- [x] **T-011**: Commit PR1 in SDD order (spec/schemas, then regenerated types), push, open PR against `develop` referencing #135.

## PR2 — Implementation (after PR1 merges)

- [x] **T-101**: `src/utils/commit-input.ts` (new) — `validateCommitInput` (manual validation, mirroring `external-duration-input`): `hash` non-empty; `total_seconds` number `>= 0` if present; `author_date`/`committer_date` parseable date-times normalized to SQLite datetime (UTC). `src/routes/commits.ts` — add the `POST /projects/:project/commits` handler under `authMiddleware`: validate → `INSERT … ON CONFLICT(user_id, project, hash) DO UPDATE … RETURNING` → shape via `rowToCommit` → `201 { data: Commit }`. File header updated.
- [x] **T-102a**: Unit tests `tests/aggregation/commit-input.test.ts` — minimal/full bodies, date normalization (Z / offset / date-only), 400 cases (hash, total_seconds, dates, non-string fields, non-object body).
- [x] **T-102b**: Integration tests `tests/integration/commits.test.ts` (extend) — create + read-back, idempotent re-post (single row, updated fields), omitted total_seconds → "0 secs", validation 400s, 401, project-from-path, cross-user isolation.
- [x] **T-103**: `npm run typecheck` — zero errors.
- [x] **T-104**: `npm test` — full suite green (323 tests) incl. new unit + integration.
- [ ] **T-105**: Commit with `feat:` prefix, push, open PR against `develop` referencing PR1 and issue #135.

## Dependencies

```
T-001 .. T-010 → T-011                  (PR1)
T-011 → T-101 .. T-105                   (PR2 after PR1 merge)
T-101 → T-102 → T-103 → T-104 → T-105
```

## Out of scope

- Server-side `total_seconds` correlation from heartbeats (research D-3) — separate issue.
- Git-host webhook receiver / signature verification (research D-1) — can sit in front as an adapter later.
- Multi-commit / push-event bulk ingestion (research D-6) — future `commits/bulk`, mirroring `heartbeats/bulk`.
- Any change to `summaries` / `hourly_summaries` / `user_projects` or the read endpoints' contract.
