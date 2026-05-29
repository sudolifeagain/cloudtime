# Tasks: Data Dumps (Export)

**Branch**: `102-data-dumps`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Generated**: 2026-05-29

## PR1 — Spec + Design

- [x] **T-001**: Author `spec.md` (2 stories, FR-001..FR-009, edge cases, spec-level decisions).
- [x] **T-002**: Author `plan.md` (Constitution Check, handler/cron/download sketches).
- [x] **T-003**: Author `research.md` (6 documented decisions).
- [x] **T-004**: Author `data-model.md` (existing table + R2 key + lifecycle statements + bundle shape).
- [x] **T-005**: Author `quickstart.md` (scenarios A–H).
- [x] **T-006**: Author `contracts/openapi-diff.md`.
- [x] **T-007**: Author `checklists/requirements.md`.
- [x] **T-008**: Add `ServiceUnavailable.yaml`; reconcile `DataDump.yaml` (`type` `daily|full`, `status` + `expired`); add `400`/`503` + descriptions + `type` enum to `data-dumps.yaml`.
- [x] **T-009**: Run `npm run generate`; verify enums + responses; run `npm run typecheck`.
- [ ] **T-010**: Commit PR1 (spec+schema, then types), push, open PR against `develop`. Flag the `heartbeats`→`full` reconciliation.

## PR2 — Implementation (after PR1 merges)

### Binding + config

- [ ] **T-101**: Add `R2_BUCKET?: R2Bucket` to `Env`; document the opt-in `[[r2_buckets]]` binding in `wrangler.toml`.

### Bundler

- [ ] **T-102**: `src/utils/export-bundle.ts` — `buildDailyExport(db, userId)` / `buildFullExport(db, userId)` (user_id-scoped D1 reads → JSON bundle).
- [ ] **T-103**: Unit tests for the bundle shapes (`daily`, `full`, empty data).

### Routes

- [ ] **T-104**: `src/routes/data-dumps.ts` — `POST` (gate 503; validate `type` 400; dedupe in-flight; insert pending; `201 {data}`) and `GET` (gate 503; list newest-first; `download_url` only when completed/unexpired). Behind `authMiddleware`.
- [ ] **T-105**: Mount in `src/index.ts`.

### Cron + download

- [ ] **T-106**: `src/cron/data-dumps.ts` — `processPendingDumps` (bounded; pending→processing→R2 put→completed/failed) + `purgeExpiredDumps` (R2 delete + status `expired`); wire into `scheduled()` via `Promise.allSettled`.
- [ ] **T-107**: Download mechanism — worker-mediated, owner+token, short-lived; expired/unknown → 404.

### Tests + docs

- [ ] **T-108**: `tests/integration/data-dumps.test.ts` — 503-when-unbound, create/dedupe, list/ownership, 400, 401 (R2 via test-pool binding or stub).
- [ ] **T-109**: `docs/operations.md` — enabling export (R2 binding, retention, download).

### Verification

- [ ] **T-110**: `npm run typecheck` — zero errors.
- [ ] **T-111**: `npm test` — full suite green incl. new unit + integration.
- [ ] **T-112**: Manual `quickstart.md` A / B / D / E with R2 bound on a staging worker.

### PR2 submission

- [ ] **T-113**: Commit with `feat:` prefix, push, open PR against `develop` referencing PR1 and issue #102.

## Dependencies

```
T-001 .. T-009 → T-010                         (PR1)
T-010 → T-101 .. T-113                          (PR2 after PR1 merge)
T-101 → T-102 → T-103 ; T-101 → T-104 → T-105
T-102 / T-104 → T-106 → T-107
T-104 / T-106 → T-108 ; T-102 → T-103
T-108 → T-110 → T-111 → T-112 → T-113
```

## Out of scope

- Import (reverse of export); Cloudflare Queues; incremental/diff exports;
  zip/compression; S3-presigned URLs (unless operator configures S3 creds).
