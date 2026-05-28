# Acceptance Checklist: Custom Rules CRUD + Heartbeat Remap

## PR1 (Spec) gate — must be ✅ before merging

- [x] `spec.md` covers FR-001..FR-012 (CRUD + remap) with no `[NEEDS CLARIFICATION]` markers.
- [x] `spec.md` documents the `action`/`operation` reconciliations and the regex deferral.
- [x] `plan.md` Constitution Check has all five principles marked PASS.
- [x] `research.md` documents the 8 design decisions.
- [x] `data-model.md` confirms no schema change and documents the write-path, KV cache, and remap field treatment.
- [x] `quickstart.md` enumerates scenarios A–J (CRUD + change/hide ingestion).
- [x] `tasks.md` separates PR1 from PR2 with dependency arrows.
- [x] `contracts/openapi-diff.md` documents the enum reconciliation and the `400`/`404` additions.
- [x] `CustomRule.yaml` / `CustomRuleInput.yaml` updated (`change|hide`, underscore operations, conditional destination).
- [x] `custom-rules.yaml` PUT has `400`; `custom-rule.yaml` DELETE has `404`.
- [x] `npm run generate` reflects the new enums and responses; `npm run typecheck` passes.
- [x] PR1 contains no changes under `src/routes/` or `src/utils/` (no runtime code).
- [x] PR1 references issue #101.

## PR2 (Implementation) gate — must be ✅ before merging

### Code

- [ ] `src/utils/custom-rule-input.ts` validates a PUT array → normalised rows | error (enum checks, `change` requires destination + non-empty destination_value, `source_value` non-empty, ≤ 50 rules).
- [ ] `src/utils/custom-rules.ts` exports a pure `applyRules(heartbeat, rules)` (returns mutated heartbeat or `null` for hide) + `loadRules` / `invalidateRules` KV helpers.
- [ ] `src/routes/custom-rules.ts` exports a Hono sub-app: `GET` (ordered), `PUT` (atomic `db.batch` replace + cache invalidate), `DELETE` (`204`/`404` + cache invalidate), all behind `authMiddleware`.
- [ ] `src/index.ts` mounts the router at `/api/v1/users/current`.
- [ ] `src/routes/heartbeats.ts` applies rules before INSERT on `POST /heartbeats` and `/heartbeats.bulk`; hidden heartbeats are filtered from the batch; per-item response order preserved.
- [ ] Hide-response shape verified against the documented WakaTime-compatible bulk contract (not by reading upstream source).
- [ ] `npm run typecheck` passes; no hand-edited generated types.

### Behaviour (per `quickstart.md`)

- [ ] A: PUT replaces; B: list ordered by priority; C: invalid PUT → 400, set unchanged; D: `[]` clears.
- [ ] E: `change` rewrites an ingested heartbeat; F: `hide` drops one (request still succeeds, no leak).
- [ ] G: bulk mix persists/changes/hides correctly with preserved order.
- [ ] H: DELETE 204 + cache invalidated; I: cross-user 404; J: unauthenticated 401.

### Tests

- [ ] `tests/aggregation/custom-rules.test.ts` (or `tests/security/`): pure matcher — each operation, change vs hide, sequential priority, short-circuit on hide, null source field, dedupe/cap.
- [ ] `tests/security/custom-rule-input.test.ts`: validation rules incl. cap and conditional destination.
- [ ] `tests/integration/custom-rules.test.ts`: CRUD scenarios A–D, H, I, J + cross-user.
- [ ] `tests/integration/custom-rules-heartbeat.test.ts`: ingestion scenarios E, F, G (change/hide on POST + bulk).
- [ ] `npm test` stays green with the new coverage.

### Performance

- [ ] No per-rule D1 read in the ingestion loop; rules loaded once per request via KV.
- [ ] Rule-count cap enforced; regex not accepted.

## Post-deployment gate

- [ ] Create a rename rule on a real instance; confirm a new heartbeat lands under the remapped value.
- [ ] Confirm a `hide` rule keeps matched heartbeats out of `summaries` after the next aggregation cycle.
- [ ] No 500s on the custom-rules endpoints or the heartbeat hot path in the first 7 days.
