# Tasks: External Durations

**Branch**: `106-external-durations`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Generated**: 2026-05-29

## PR1 — Spec + Design

- [x] **T-001**: Author `spec.md` (3 stories, FR-001..FR-007, edge cases, spec-level decisions).
- [x] **T-002**: Author `plan.md` (Constitution Check, validation + SQL sketches).
- [x] **T-003**: Author `research.md` (5 documented decisions).
- [x] **T-004**: Author `data-model.md` (existing table; upsert/list/delete statements).
- [x] **T-005**: Author `quickstart.md` (scenarios A–H).
- [x] **T-006**: Author `contracts/openapi-diff.md`.
- [x] **T-007**: Author `checklists/requirements.md`.
- [x] **T-008**: Add `400` responses + descriptions to both external-duration path files (keep `maxItems: 100`).
- [x] **T-009**: Run `npm run generate`; verify the 400 responses appear and no body type-shape change; run `npm run typecheck`.
- [ ] **T-010**: Commit PR1 (spec+schema, then types), push, open PR against `develop`.

## PR2 — Implementation (after PR1 merges)

### Validation

- [ ] **T-101**: `src/utils/external-duration-input.ts` — `validateExternalDuration(body)` → `{ ok, value | error }` (required `external_id`/`entity`, `type ∈ file|app|domain`, numeric `start_time`/`end_time`, `end_time ≥ start_time`, optional strings).
- [ ] **T-102**: Unit tests for the validator.

### Route

- [ ] **T-103**: `src/routes/external-durations.ts` — Hono sub-app, all four handlers behind `authMiddleware`:
  - `POST /external_durations` (validate → upsert → `201 {data}`)
  - `POST /external_durations.bulk` (validate all ≤100 → `db.batch` upsert → `201 {data[]}`; any invalid → 400)
  - `GET /external_durations?date=` (day bounds via `getEpochBoundsForDate`, `project`/`branches` filters, `400` bad date)
  - `DELETE /external_durations.bulk` (`{date, ids}`, scoped delete, `204`, `400` bad body)
- [ ] **T-104**: Mount in `src/index.ts`: `app.route("/api/v1/users/current", externalDurations)`.

### Tests

- [ ] **T-105**: `tests/integration/external-durations.test.ts` — create/upsert, bulk all-or-nothing, list-by-day + filters, bulk delete + unknown-id ignore, cross-user, 401; assert `/stats` unaffected.

### Verification

- [ ] **T-106**: `npm run typecheck` — zero errors.
- [ ] **T-107**: `npm test` — full suite green incl. new unit + integration.
- [ ] **T-108**: Manual run of `quickstart.md` A / B / D / G against a staging worker.

### PR2 submission

- [ ] **T-109**: Commit with `feat:` prefix, push, open PR against `develop` referencing PR1 and issue #106.

## Dependencies

```
T-001 .. T-009 → T-010              (PR1)
T-010 → T-101 .. T-109              (PR2 after PR1 merge)
T-101 → T-102 ; T-101 → T-103 → T-104
T-103 / T-104 → T-105 → T-106 → T-107 → T-108 → T-109
```

## Out of scope

- Aggregating external durations into `summaries` / stats / insights.
- A live calendar / Zoom sync integration (source side).
- Per-id single DELETE (bulk only).
- Overlap/merge logic with heartbeats.
