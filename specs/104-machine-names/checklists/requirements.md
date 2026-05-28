# Acceptance Checklist: Machine Names Endpoint

## PR1 (Spec) gate — must be ✅ before merging

- [x] `spec.md` covers FR-001..FR-008 (ingestion population + list) with no `[NEEDS CLARIFICATION]` markers.
- [x] `plan.md` Constitution Check has all five principles marked PASS.
- [x] `research.md` documents the 5 design decisions (side registry vs FK, IP source, registration-follows-persistence, batched dedupe, ordering).
- [x] `data-model.md` confirms no schema change and documents the upsert + read query.
- [x] `quickstart.md` enumerates scenarios A–G.
- [x] `tasks.md` separates PR1 from PR2 with dependency arrows.
- [x] `contracts/openapi-diff.md` documents the description-only clarifications.
- [x] `machine-names.yaml` and `Machine.yaml` carry the clarifying descriptions.
- [x] `npm run generate` produces only JSDoc changes (no type-shape change); `npm run typecheck` passes.
- [x] PR1 contains no runtime code changes under `src/` (only regenerated `src/types/generated.ts`).
- [x] PR1 references issue #104.

## PR2 (Implementation) gate — must be ✅ before merging

### Code

- [ ] `src/utils/machine.ts` exports `machineUpsertStmt(db, userId, value, ip)` building the `INSERT … ON CONFLICT` statement.
- [ ] `src/routes/heartbeats.ts` upserts distinct machines into the existing batch on `POST /heartbeats` and `/heartbeats.bulk`, only for persisted (valid, non-hidden) heartbeats, with `ip = CF-Connecting-IP ?? null`.
- [ ] `src/routes/machines.ts` exports a Hono sub-app with `GET /machine_names` (ordered by `last_seen_at` DESC) behind `authMiddleware`, mirroring `user-agents.ts`.
- [ ] `src/index.ts` mounts the router at `/api/v1/users/current`.
- [ ] `npm run typecheck` passes; no hand-edited generated types.

### Behaviour (per `quickstart.md`)

- [ ] A: two devices register and list newest-first.
- [ ] B: repeat device advances `last_seen_at`, no duplicate.
- [ ] C: `X-Machine-Name` header is honoured when body omits `machine`.
- [ ] D: a heartbeat without a machine registers nothing.
- [ ] E: a hidden heartbeat (custom rule) registers no machine.
- [ ] F: bulk dedupes one device into a single upsert.
- [ ] G: unauthenticated 401; cross-user isolation.

### Tests

- [ ] `tests/integration/machine-names.test.ts`: ingestion population (single + bulk dedupe), repeat-upsert no-duplicate, no-machine no-row, hidden-heartbeat no-row, list ordering, cross-user isolation, 401.
- [ ] `npm test` stays green with the new coverage.

## Post-deployment gate

- [ ] Send heartbeats from two real devices and confirm both appear, newest-active first.
- [ ] Confirm `ip` shows only the requesting user's own device addresses.
- [ ] No 500s on the endpoint or the heartbeat hot path in the first 7 days.
