# Implementation Plan: Bulk commit ingestion

**Branch**: `147-commits-bulk-ingestion` | **Date**: 2026-07-09 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/147-commits-bulk-ingestion/spec.md`

## Summary

Add `POST /users/current/projects/{project}/commits.bulk` that ingests up to 100 commits in one request. All-or-nothing validation (every element through the existing `validateCommitInput`), then a **single** `db.batch()` of the existing idempotent `(user_id, project, hash)` upserts, returning `201` with the stored `Commit[]` in request order. It mirrors `external_durations.bulk` and reuses the single endpoint's validation and `UPSERT_SQL` unchanged. No schema change.

Unlike the single endpoint, bulk does **not** correlate heartbeats to derive `total_seconds` (research D-3): per-element correlation is O(N) extra D1 reads + CPU that breaks the Workers per-request budget for a 100-element batch. Supplied `total_seconds` (incl. explicit `0`) is stored verbatim; omitted → stored absent.

**PR1 (this PR)**: SpecKit artifacts + OpenAPI (`createProjectCommitsBulk` operation on a new `commits.bulk` path; endpoint-neutral reword of `CommitInput.total_seconds`) + regenerated types. **No route/business logic.**

**PR2 (after PR1 merges)**: the `POST .../commits.bulk` handler (validate all → single `db.batch()` → return `Commit[]`) + unit + integration tests.

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers)
**Primary Dependencies**: Hono >= 4.9.7; existing `validateCommitInput` (`src/utils/commit-input.ts`)
**Storage**: D1 `commits` (existing) — one `db.batch([...])` of `INSERT … ON CONFLICT(user_id, project, hash) DO UPDATE … RETURNING`
**Testing**: Vitest + workers pool — integration tests for bulk create, all-or-nothing 400 (bad element, over-cap, non-array), empty array, idempotent re-post, omitted `total_seconds` → `"0 secs"` (no correlation), read-back, cross-user isolation; a unit-level assertion that a bad element short-circuits before any write
**Performance Goals**: <10ms CPU — O(N) in-memory validation + one `db.batch()`; no per-element round-trip, no heartbeat scan (FR-011)
**Constraints**: reuse `validateCommitInput`, `UPSERT_SQL`, and `rowToCommit` from the single endpoint; mirror the `external_durations.bulk` handler (`src/routes/external-durations.ts`); D1 bulk write via `db.batch()` per `docs/cloudflare-constraints.md`

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | OpenAPI operation lands first (PR1); handler follows in PR2. Types regenerated, never hand-edited. |
| II. Cloudflare-Native | PASS | Single `db.batch()` (one round-trip) on the existing UNIQUE index; no per-element query, no heartbeat scan, no new binding. |
| III. Type Safety | PASS | Handler uses `components["schemas"]["CommitInput"]` / `["Commit"]` from generated types; reuses `ValidatedCommit`. |
| IV. Legal/Trademark | PASS | Original first-party endpoint mirroring our own `external_durations.bulk`; no third-party source consulted or payload copied. |
| V. Simplicity First | PASS | One operation, no new request/response schema, no schema change, no heartbeat correlation. Reuses the single endpoint's validator + upsert. |

## Project Structure

### Documentation (this feature)

```text
specs/147-commits-bulk-ingestion/
├── plan.md
├── spec.md
├── research.md
├── data-model.md
├── quickstart.md
├── tasks.md
├── contracts/
│   └── openapi-diff.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
# PR1
schemas/paths/commits/commits-bulk.yaml        # NEW: post (createProjectCommitsBulk)
schemas/openapi.yaml                            # CHANGE: register /users/current/projects/{project}/commits.bulk
schemas/components/schemas/CommitInput.yaml     # CHANGE (description only): endpoint-neutral total_seconds prose
src/types/generated.ts                          # REGENERATED (npm run generate)

# PR2 (after PR1 merges)
src/routes/commits.ts                           # CHANGE: add the POST .../commits.bulk handler; extract shared upsert-statement + array-validation helpers; update file header
```

**Structure Decision**: Keep the handler thin and mirror `external_durations.bulk`. Parse the body → reject non-array / over-cap → validate every element with the existing `validateCommitInput` (returning `400 item {i}: …` on the first failure) → build one `db.batch()` of the existing `UPSERT_SQL` bound per element → map the batch results through the existing `rowToCommit` → `201 { data: Commit[] }`. `project` is read from the path; auth is the existing `authMiddleware`. No new table, no aggregate writes, no correlation query.

## Phases

- **PR1 — Spec + Design (this PR)**: author the SpecKit set; add the `commits-bulk.yaml` path + register it; reword `CommitInput.total_seconds` to be endpoint-neutral; `npm run lint:api`; `npm run generate`; `npm run typecheck`.
- **PR2 — Implementation**: bulk handler (validate-all → single `db.batch()` → `Commit[]`) + unit + integration tests; `npm test` green; open PR referencing #147 and PR1.

## Risks & Mitigations

- **Per-element correlation blowing the request budget** → bulk does not correlate (FR-005, research D-3); `total_seconds` is client-supplied only. Follow-up "shared-window batch correlation" is explicitly deferred, not silently dropped.
- **Partial writes on a bad element** → all-or-nothing: validate the whole array before the single `db.batch()` (FR-002); integration test asserts a mid-batch bad element leaves nothing written.
- **Duplicate rows from retries / overlapping push ranges** → idempotent upsert on the existing `(user_id, project, hash)` UNIQUE index (FR-004); test re-posts a hash across batches and asserts one row.
- **Over-large batch → D1 limits** → capped at 100 (matches `external_durations.bulk`, already shipped at that cap); one `db.batch()` of 100 statements is a single round-trip (research D-4).
- **Type drift** → request/response types are generated from the existing `CommitInput`/`Commit`; the generate diff is reviewed to confirm only the additive operation + path member + the `CommitInput` JSDoc reword.
