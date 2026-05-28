# Tasks: Machine Names Endpoint

**Branch**: `104-machine-names`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Generated**: 2026-05-29

## PR1 — Spec + Design

- [x] **T-001**: Author `spec.md` (2 user stories, FR-001..FR-008, NFRs, edge cases).
- [x] **T-002**: Author `plan.md` (Constitution Check, upsert + route sketches).
- [x] **T-003**: Author `research.md` (5 documented decisions).
- [x] **T-004**: Author `data-model.md` (existing table; upsert + read query).
- [x] **T-005**: Author `quickstart.md` (scenarios A–G).
- [x] **T-006**: Author `contracts/openapi-diff.md`.
- [x] **T-007**: Author `checklists/requirements.md`.
- [x] **T-008**: Add clarifying descriptions to `machine-names.yaml` (`getMachineNames`) and `Machine.yaml` (fields). No type-shape change.
- [x] **T-009**: Run `npm run generate` (JSDoc-only diff); run `npm run typecheck`.
- [ ] **T-010**: Commit PR1 (spec+schema, then types), push, open PR against `develop`.

## PR2 — Implementation (after PR1 merges)

### Upsert helper

- [ ] **T-101**: `src/utils/machine.ts` — `machineUpsertStmt(db, userId, value, ip)` returning the `INSERT … ON CONFLICT (user_id, value) DO UPDATE` statement.

### Heartbeat integration

- [ ] **T-102**: In `src/routes/heartbeats.ts`, resolve `ip = c.req.header("CF-Connecting-IP") ?? null`; for the single POST, push one machine upsert when a persisted heartbeat has a `machine`; for bulk, collect distinct machine values from persisted (valid, non-hidden) items and push one upsert each. Fold into the existing `db.batch()`.

### Read route

- [ ] **T-103**: `src/routes/machines.ts` — Hono sub-app, `GET /machine_names` ordered by `last_seen_at` DESC, `rowToMachine` mirroring `rowToUserAgent`, behind `authMiddleware`.
- [ ] **T-104**: Mount in `src/index.ts`: `app.route("/api/v1/users/current", machines)`.

### Tests

- [ ] **T-105**: `tests/integration/machine-names.test.ts` — scenarios A–G (population single + bulk dedupe, repeat upsert, no-machine, hidden-heartbeat, ordering, cross-user, 401).

### Verification

- [ ] **T-106**: `npm run typecheck` — zero errors.
- [ ] **T-107**: `npm test` — full suite green incl. new integration.
- [ ] **T-108**: Manual run of `quickstart.md` A / B / E against a staging worker.

### PR2 submission

- [ ] **T-109**: Commit with `feat:` prefix, push, open PR against `develop` referencing PR1 and issue #104.

## Dependencies

```
T-001 .. T-009 → T-010                  (PR1)
T-010 → T-101 .. T-109                   (PR2 after PR1 merge)
T-101 → T-102                            (helper before ingestion hook)
T-103 → T-104                            (route before mount)
T-102 / T-104 → T-105                    (integration needs ingestion + list)
T-105 → T-106 → T-107 → T-108 → T-109
```

## Out of scope

- Per-machine activity stats or summary filtering by machine.
- Machine rename / merge / delete (no mutation endpoints).
- Foreign-keying `heartbeats.machine`.
- IP geo-resolution / enrichment.
