# Requirements Checklist: Bulk commit ingestion

**Branch**: `147-commits-bulk-ingestion` | **Spec**: [spec.md](../spec.md)

Quality gate for the spec before implementation. Each item is verifiable against `spec.md`.

## Completeness

- [x] Every functional requirement (FR-001…FR-011) maps to at least one acceptance scenario or success criterion.
- [x] Endpoint shape fixed and justified (`.bulk` bare array; wrapper object + push-event object rejected) — research D-1.
- [x] All-or-nothing contract fixed: validate whole array first, single `db.batch()`, always 201, empty → `{ data: [] }` — FR-002/FR-003/FR-006, research D-2.
- [x] `total_seconds` semantics fixed: client-supplied, stored verbatim (incl. 0), omitted → absent, **no bulk correlation** — FR-005, research D-3.
- [x] Batch cap fixed (100) and justified vs the heartbeat cap of 25 — FR-003, research D-4.
- [x] In-batch idempotency (duplicate `(project, hash)` last-wins) specified — US3 scenario 2, research D-5.

## Consistency

- [x] Response is the existing `Commit` shape via the read-path shaping — FR-006, data-model.
- [x] All-or-nothing + single `db.batch()` mirrors the `external_durations.bulk` convention — research D-2.
- [x] Reuses the single endpoint's `validateCommitInput` + upsert; no new request/response schema — research D-6, data-model.
- [x] `CommitInput.total_seconds` description made endpoint-neutral so it does not contradict the no-correlation bulk behavior — contracts/openapi-diff §3.
- [x] Read endpoints (#107) unchanged; bulk-ingested rows flow through their ordering/filters — FR-009.
- [x] Single-commit endpoint (#135/#145) behavior unchanged — spec Background, tasks Out of scope.

## Testability

- [x] Each user story has an Independent Test.
- [x] Success criteria are measurable (SC-001…SC-006), including the single-round-trip `db.batch()` claim (SC-006).
- [x] Quickstart scenarios A–I cover bulk create, read-back, no-correlation, all-or-nothing, validation 400s, empty array, idempotent re-post, 401, path-project + isolation.

## Compliance

- [x] No schema change; D1 bulk write via a single `db.batch()` on the existing UNIQUE index; no per-element round-trip, no heartbeat scan (Cloudflare-Native, Simplicity) — FR-011, research D-3/D-4.
- [x] Generated-types impact assessed (additive `createProjectCommitsBulk` + path member; description-only `CommitInput` reword) in contracts/openapi-diff.md.
- [x] Original first-party endpoint mirroring our own `external_durations.bulk`; no third-party source consulted, no provider payload copied (Legal/Trademark).
