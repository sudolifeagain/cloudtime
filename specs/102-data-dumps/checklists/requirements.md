# Acceptance Checklist: Data Dumps (Export)

## PR1 (Spec) gate — must be ✅ before merging

- [x] `spec.md` covers FR-001..FR-009 (request / list / async build / expiry / gating) with no `[NEEDS CLARIFICATION]` markers.
- [x] `spec.md` records the spec-level decisions (R2-gated 503, cron sweep, `type` `daily|full`, `status` + `expired`).
- [x] `plan.md` Constitution Check has all five principles marked PASS.
- [x] `research.md` documents the 6 design decisions (incl. the flagged `heartbeats`→`full` reconciliation and worker-mediated download).
- [x] `data-model.md` confirms no D1 schema change, documents the R2 key + lifecycle statements + bundle shape.
- [x] `quickstart.md` enumerates scenarios A–H (incl. the 503-when-unbound path).
- [x] `tasks.md` separates PR1 from PR2 with dependency arrows.
- [x] `contracts/openapi-diff.md` documents the enum reconciliation, required `created_at`, required 503 error body, and `400`/`503` additions.
- [x] `ServiceUnavailable.yaml` exists; `DataDump.yaml` + `data-dumps.yaml` carry the reconciled enums, required `created_at`, descriptions, and 400/503.
- [x] `npm run generate` reflects `type: daily|full`, `status` + `expired`, required `created_at`, and the new responses; `npm run typecheck` passes.
- [x] PR1 contains no runtime code under `src/` (only regenerated `src/types/generated.ts`).
- [x] PR1 references issue #102 and flags the `type` reconciliation for review.

## PR2 (Implementation) gate — must be ✅ before merging

### Code

- [ ] `src/types.ts` adds `R2_BUCKET?: R2Bucket`; `wrangler.toml` documents the (commented, opt-in) `[[r2_buckets]]` binding.
- [ ] `src/routes/data-dumps.ts`: both handlers gate on `R2_BUCKET` (503 when unbound), behind `authMiddleware`:
  - `POST` — validate `type ∈ {daily, full}` (400), dedupe in-flight, insert `pending`, return `201 {data}`.
  - `GET` — list user's dumps newest-first; omit `download_url` unless `completed` & unexpired.
- [ ] `src/utils/export-bundle.ts`: `buildDailyExport` / `buildFullExport` — `user_id`-scoped D1 reads → JSON; unit-tested for shape.
- [ ] `src/cron/data-dumps.ts`: `processPendingDumps` (bounded per run: pending → processing → R2 put → completed/failed) and `purgeExpiredDumps` (R2 delete + status `expired`); wired into `scheduled()` via `Promise.allSettled`.
- [ ] Download mechanism (worker-mediated route or presigned), short-lived + owner-only; expired/unknown → 404.
- [ ] `src/index.ts` mounts the route (+ cron wiring).
- [ ] `npm run typecheck` passes; no hand-edited generated types.

### Behaviour (per `quickstart.md`)

- [ ] A: 503 when R2 unbound (both endpoints). B: POST → pending. C: dedupe returns the in-flight dump. D: cron → completed with `download_url`/`expires_at`.
- [ ] E: download returns the bundle (correct keys per `type`). F: unknown `type` 400. G: expiry → `expired` + 404 + R2 object gone. H: 401 + cross-user isolation.

### Tests

- [ ] `tests/integration/data-dumps.test.ts`: 503-when-unbound, create/dedupe, list/ownership, validation 400, 401. (Cron build/purge + R2 via the test pool's R2 binding or a stub.)
- [ ] `tests/aggregation/export-bundle.test.ts` (or similar): bundle shape for `daily` and `full`.
- [ ] `npm test` stays green with the new coverage.

### Docs

- [ ] `docs/operations.md`: section on enabling export (R2 binding, retention, download).

## Post-deployment gate

- [ ] With R2 bound, request a `full` export, confirm the cron builds it and the download round-trips the data.
- [ ] Confirm an expired dump is purged from R2 and marked `expired`.
- [ ] Without R2 bound, confirm 503 and no errors in logs.
