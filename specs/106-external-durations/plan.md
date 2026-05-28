# Implementation Plan: External Durations

**Branch**: `106-external-durations` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/106-external-durations/spec.md`

## Summary

Wire the four declared `external_durations` operations to handlers backed by the existing table. Mirrors the heartbeat handlers (single + bulk create, GET by day, bulk delete) but with two differences: create is an **upsert** on `(user_id, external_id)`, and the data is a **parallel series** — the cron aggregator is untouched.

PR1 (this PR): SpecKit artifacts + OpenAPI reconciliation (add `400` responses, document upsert idempotency / parallel-series / day-scoped GET). PR2: the route + a validation helper + tests.

No D1 migration, no new binding.

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers)
**Primary Dependencies**: Hono >= 4.9.7
**Storage**: D1 (`external_durations`, existing)
**Testing**: Vitest + workers pool — validation unit tests + endpoint integration tests
**Performance Goals**: <10ms CPU — single-row upsert / bulk `db.batch()` / one indexed SELECT
**Constraints**: bulk ≤ 100; GET uses `idx_ext_durations_user_time`

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | Operations already declared; PR1 adds `400` responses + descriptions, PR2 implements. `npm run generate` adds the 400 response types + JSDoc. |
| II. Cloudflare-Native | PASS | D1 upsert + `db.batch()` + indexed SELECT. Reuses the heartbeat date→epoch helper. No new bindings. |
| III. Type Safety | PASS | Handlers use `components["schemas"]["ExternalDuration"]` / `["ExternalDurationInput"]`. No hand-edited types. |
| IV. Legal/Trademark | PASS | Original contract from our own schema; no upstream source/assets. |
| V. Simplicity First | PASS | One route + one validation helper, mirroring heartbeats. Cron untouched (parallel series). |

## Project Structure

### Documentation (this feature)

```text
specs/106-external-durations/
├── plan.md, spec.md, research.md, data-model.md, quickstart.md, tasks.md
├── contracts/openapi-diff.md
└── checklists/requirements.md
```

### Source Code (repository root) — landed in PR2

```text
src/
├── routes/
│   └── external-durations.ts   # NEW: 4 handlers (get / create / bulk create / bulk delete)
├── utils/
│   └── external-duration-input.ts  # NEW: validateExternalDuration(body) → row | error
└── index.ts                    # NEW route mount
```

**Structure Decision**: One router for the resource (mounted at `/users/current`, defining `/external_durations` and `/external_durations.bulk`), mirroring `heartbeats.ts`. Validation is a pure helper so the rules are unit-testable without D1.

## Phase 0 — Research Outputs

See [research.md](./research.md). Key decisions:
1. **Upsert on `(user_id, external_id)`** — idempotent replayable syncs.
2. **Parallel series** — not aggregated into `summaries`; cron untouched.
3. **Bulk cap 100** (OpenAPI SSoT over the issue's prose 25), **all-or-nothing** validation.
4. **GET day-scoped** by `start_time` in the user's (or query) timezone; `project`/`branches` filters.
5. **Delete** by `id` within day, scoped by `user_id`; unknown ids ignored.

## Phase 1 — Design Outputs

### Validation helper sketch

```ts
// src/utils/external-duration-input.ts
const TYPES = new Set(["file", "app", "domain"]);
export function validateExternalDuration(body: unknown): { ok: true; value: ValidatedExt } | { ok: false; error: string } {
  // external_id, entity non-empty strings; type ∈ TYPES; start_time/end_time finite; end_time >= start_time;
  // optional category/project/branch/language/meta strings.
}
```

### Upsert SQL (single + per bulk element)

```sql
INSERT INTO external_durations
  (id, user_id, external_id, entity, type, category, start_time, end_time, project, branch, language, meta)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT (user_id, external_id) DO UPDATE SET
  entity = excluded.entity, type = excluded.type, category = excluded.category,
  start_time = excluded.start_time, end_time = excluded.end_time,
  project = excluded.project, branch = excluded.branch, language = excluded.language, meta = excluded.meta
RETURNING id, user_id, external_id, entity, type, category, start_time, end_time, project, branch, language, meta, created_at;
```

Single create uses `.first()` on the RETURNING; bulk uses `db.batch()` of the upserts (no RETURNING needed across batch — re-SELECT by the request's `external_id`s, or return the validated rows with their resolved ids).

### GET / DELETE

- GET: `getEpochBoundsForDate(date, tz)` → `WHERE user_id = ? AND start_time >= ? AND start_time < ?` (+ optional `project = ?`, `branch IN (…)`), `ORDER BY start_time ASC`.
- DELETE: `DELETE FROM external_durations WHERE user_id = ? AND start_time >= ? AND start_time < ? AND id IN (…)`.

### OpenAPI surface

Already declared; PR1 adds `400` responses + descriptions — see [contracts/openapi-diff.md](./contracts/openapi-diff.md).

## Phase 2 — Implementation Tasks

See [tasks.md](./tasks.md).

## Complexity Tracking

Bounded: mirrors heartbeats, minus the cron coupling (parallel series). The only new wrinkle is the upsert + all-or-nothing bulk, both straightforward.
