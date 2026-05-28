# Tasks: Custom Rules CRUD + Heartbeat Remap

**Branch**: `101-custom-rules-crud`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Generated**: 2026-05-28

## PR1 — Spec + Design

- [x] **T-001**: Author `spec.md` (4 user stories, FR-001..FR-012, NFRs, edge cases, reconciliations).
- [x] **T-002**: Author `plan.md` (Constitution Check, matcher/cache/handler sketches).
- [x] **T-003**: Author `research.md` (8 documented decisions).
- [x] **T-004**: Author `data-model.md` (existing table; write-path, KV cache, remap field treatment).
- [x] **T-005**: Author `quickstart.md` (scenarios A–J).
- [x] **T-006**: Author `contracts/openapi-diff.md`.
- [x] **T-007**: Author `checklists/requirements.md`.
- [x] **T-008**: Reconcile `CustomRule.yaml` / `CustomRuleInput.yaml` (`change|hide`, underscore operations, conditional destination, `created_at`); add `400` to PUT and `404` to DELETE.
- [x] **T-009**: Run `npm run generate`; verify enums + responses in `src/types/generated.ts`; run `npm run typecheck`.
- [ ] **T-010**: Commit PR1 (spec+schema, then types), push, open PR against `develop`.

## PR2 — Implementation (after PR1 merges)

### Validation + matcher

- [ ] **T-101**: `src/utils/custom-rule-input.ts` — `validateCustomRules(body)` → normalised rows | error. Enum checks, `change` requires `destination` + non-empty `destination_value`, `source_value` non-empty, ≤ 50 rules, `priority` defaulting.
- [ ] **T-102**: `src/utils/custom-rules.ts` — pure `applyRules(hb, rules)` (mutate or `null`) + `loadRules` / `invalidateRules` KV helpers (key `customrules:${userId}`).
- [ ] **T-103**: Unit tests for the matcher (each operation, change/hide, sequential priority, hide short-circuit, null source) and validation (cap, conditional destination).

### CRUD handlers

- [ ] **T-104**: `src/routes/custom-rules.ts` — `GET` (ORDER BY priority, created_at), `PUT` (validate → `db.batch([DELETE all, INSERT each])` → invalidate cache → return persisted), `DELETE` (`WHERE id=? AND user_id=?`; 204/404; invalidate cache). All behind `authMiddleware`.
- [ ] **T-105**: Mount in `src/index.ts`: `app.route("/api/v1/users/current", customRules)`.

### Heartbeat integration

- [ ] **T-106**: In `src/routes/heartbeats.ts`, load rules once per request and apply per heartbeat on `POST /heartbeats` and `/heartbeats.bulk`; filter `null` (hidden) from the batch; preserve per-item response order.
- [ ] **T-107**: Verify the hidden-heartbeat success-response shape against the documented WakaTime-compatible bulk contract (API docs / `wakatime-cli` behaviour — not source).

### Tests

- [ ] **T-108**: `tests/integration/custom-rules.test.ts` — CRUD scenarios A–D, H, I, J + cross-user.
- [ ] **T-109**: `tests/integration/custom-rules-heartbeat.test.ts` — ingestion scenarios E, F, G.

### Verification

- [ ] **T-110**: `npm run typecheck` — zero errors.
- [ ] **T-111**: `npm test` — full suite green incl. new unit + integration.
- [ ] **T-112**: Manual run of `quickstart.md` E / F / G against a staging worker.

### PR2 submission

- [ ] **T-113**: Commit with `feat:` prefix, push, open PR against `develop` referencing PR1 and issue #101.

## Dependencies

```
T-001 .. T-009 → T-010                         (PR1)
T-010 → T-101 .. T-113                          (PR2 after PR1 merge)
T-101 / T-102 → T-103
T-101 / T-102 → T-104 → T-105
T-102 → T-106 → T-107
T-104 / T-105 → T-108
T-106 / T-107 → T-109
T-108 / T-109 → T-110 → T-111 → T-112 → T-113
```

## Out of scope

- `regex` operator (additive later).
- Retroactive application to stored heartbeats / summaries.
- Per-rule enable/disable, dry-run/preview, single-rule POST/PATCH.
- Fixpoint re-evaluation beyond the documented sequential semantics.
