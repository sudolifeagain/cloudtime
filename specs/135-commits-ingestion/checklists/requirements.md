# Requirements Checklist: Commit ingestion (write path)

**Branch**: `135-commits-ingestion` | **Spec**: [spec.md](../spec.md)

Quality gate for the spec before implementation. Each item is verifiable against `spec.md`.

## Completeness

- [x] Every functional requirement (FR-001…FR-010) maps to at least one acceptance scenario or success criterion.
- [x] Ingestion model fixed and justified (dedicated POST; webhook + heartbeat-attach rejected) — research D-1.
- [x] Idempotency contract fixed: upsert on `(user_id, project, hash)`, always 201 — FR-002, research D-2.
- [x] `total_seconds` semantics fixed: client-supplied, optional, `>= 0`, not server-computed — FR-004, research D-3.
- [x] Date validation/normalization specified — FR-005, research D-4.
- [x] Request-body fields enumerated (`CommitInput`); `project` sourced from path — FR-008, data-model.

## Consistency

- [x] Response is the existing `Commit` shape via the read-path shaping — FR-006, data-model.
- [x] Idempotent-POST + 201 mirrors the `createExternalDuration` convention — research D-2.
- [x] Read endpoints (#107) unchanged; ingested rows flow through their ordering/filters — FR-009.
- [x] Out-of-scope items named: server-side timing, webhooks, bulk, aggregate writes (research D-3/D-1/D-6, FR-010).

## Testability

- [x] Each user story has an Independent Test.
- [x] Success criteria are measurable (SC-001…SC-005).
- [x] Quickstart scenarios A–H cover create, read-back, idempotency, omitted time, 400s, 401, path-project, isolation.

## Compliance

- [x] No schema change; single-row D1 upsert on the existing UNIQUE index (Cloudflare-Native, Simplicity).
- [x] Generated-types impact assessed (additive `createProjectCommit` + `CommitInput`) in contracts/openapi-diff.md.
- [x] Original first-party endpoint; no WakaTime source consulted, no provider payload copied (Legal/Trademark).
