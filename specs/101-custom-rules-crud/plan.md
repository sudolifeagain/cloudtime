# Implementation Plan: Custom Rules CRUD + Heartbeat Remap

**Branch**: `101-custom-rules-crud` | **Date**: 2026-05-28 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/101-custom-rules-crud/spec.md`

## Summary

Two parts: (1) a CRUD surface for `custom_rules` (`GET` list, `PUT` full-replace, `DELETE` one), and (2) ingestion-time enforcement that rewrites or drops heartbeats per the user's rules on `POST /heartbeats` and `POST /heartbeats.bulk`. Rules are KV-cached per user and invalidated on mutation so the heartbeat hot path avoids a D1 read.

PR1 (this PR): SpecKit artifacts + the reconciled OpenAPI (`action: change|hide`, underscore `operation` tokens, conditional `destination`, `400`/`404` responses) + regenerated types. No runtime code. PR2: validation module, CRUD handlers, the remap helper, the ingestion hook, and tests.

No D1 migration, no new binding (KV already bound).

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers)
**Primary Dependencies**: Hono >= 4.9.7
**Storage**: D1 (`custom_rules`, existing); KV (rule-set cache, existing binding)
**Testing**: Vitest + workers pool — unit tests for matching/validation, integration tests for CRUD + ingestion remap
**Performance Goals**: <10ms CPU per heartbeat request; no per-rule D1 read; string ops only
**Constraints**: Workers CPU budget; D1 batch for the PUT replace

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | OpenAPI reconciled first (this PR); `npm run generate` re-emits `CustomRule` / `CustomRuleInput` and the `400`/`404` responses. Handlers land in PR2. |
| II. Cloudflare-Native | PASS | D1 + existing KV cache. PUT uses `db.batch()` for the atomic replace. No new services. |
| III. Type Safety | PASS | Handlers consume `components["schemas"]["CustomRule"]` / `["CustomRuleInput"]`. No hand-edited types. |
| IV. Legal/Trademark | PASS | Rule semantics designed from our own schema + issue #101. The one wire-protocol touch point (hide-response shape) is verified against the documented WakaTime-compatible contract, never by reading their source. |
| V. Simplicity First | PASS | One validation module, one pure `applyRules` matcher, three thin handlers, one ingestion hook. Regex deferred to avoid an engine + time-boxing. |

## Project Structure

### Documentation (this feature)

```text
specs/101-custom-rules-crud/
├── plan.md
├── spec.md
├── research.md
├── data-model.md
├── quickstart.md
├── tasks.md
├── contracts/
│   └── openapi-diff.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root) — landed in PR2

```text
src/
├── routes/
│   └── custom-rules.ts        # NEW: getCustomRules / updateCustomRules / deleteCustomRule
├── utils/
│   ├── custom-rule-input.ts   # NEW: validateCustomRules(body) → normalised rows | error
│   └── custom-rules.ts        # NEW: loadRules(cache) + applyRules(heartbeat, rules) (pure matcher)
├── routes/heartbeats.ts       # EXTEND: apply rules before INSERT (single + bulk)
└── index.ts                   # NEW route mount: app.route("/api/v1/users/current", customRules)
```

**Structure Decision**: CRUD handlers in a new `custom-rules.ts` router (one router per resource). The matcher (`applyRules`) is a pure function over a heartbeat-like object + rule list so it is unit-testable without D1 or KV. Cache load/invalidate helpers wrap KV.

## Phase 0 — Research Outputs

See [research.md](./research.md). Key decisions:
1. `action` = **`change | hide`** (reconciled from `delete`).
2. `operation` = **`equals | contains | starts_with | ends_with`**; **regex deferred**.
3. **PUT is full-replace** via `db.batch([DELETE all, INSERT each])`; validate before writing.
4. Cross-user / unknown DELETE → **404**.
5. **KV-cached rule set** keyed by `user_id`, invalidated on PUT/DELETE.
6. **Sequential application** by priority; first `hide` short-circuits.
7. **hide-response shape** mirrors the WakaTime-compatible bulk contract — verified in PR2.
8. **Validation cap** ≤ 50 rules; `hide` stores empty-string destination to satisfy NOT NULL.

## Phase 1 — Design Outputs

### Matcher sketch (pure, unit-testable)

```ts
// src/utils/custom-rules.ts
export interface CompiledRule {
  action: "change" | "hide";
  source: HeartbeatField;
  operation: "equals" | "contains" | "starts_with" | "ends_with";
  source_value: string;
  destination: HeartbeatField;
  destination_value: string;
  priority: number;
}

type Mutable = Record<HeartbeatField, string | null | undefined>;

/** Returns the mutated heartbeat, or null when a hide rule matched. */
export function applyRules<T extends Mutable>(hb: T, rules: CompiledRule[]): T | null {
  for (const rule of rules) {            // pre-sorted by priority, created_at
    const field = hb[rule.source];
    if (typeof field !== "string" || !matches(field, rule.operation, rule.source_value)) continue;
    if (rule.action === "hide") return null;
    (hb as Mutable)[rule.destination] = rule.destination_value;
  }
  return hb;
}
```

### Cache helpers

```ts
// key: `customrules:${userId}` in KV; value: JSON CompiledRule[]
loadRules(env, userId): Promise<CompiledRule[]>      // KV hit → parse; miss → D1 SELECT + populate
invalidateRules(env, userId): Promise<void>          // KV delete; called by PUT + DELETE
```

### CRUD handler sketch

```ts
customRules.get("/custom_rules", … ORDER BY priority ASC, created_at ASC);
customRules.put("/custom_rules", async (c) => {
  const parsed = validateCustomRules(await c.req.json().catch(() => null));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const rows = parsed.value.map((r, i) => ({ id: crypto.randomUUID(), priority: r.priority ?? i, ...r }));
  await c.env.DB.batch([deleteAllForUser, ...rows.map(insert)]);
  await invalidateRules(c.env, userId);
  return c.json({ data: rows.map(rowToCustomRule) });
});
customRules.delete("/custom_rules/:rule_id", async (c) => {
  const res = await db.prepare("DELETE … WHERE id=? AND user_id=?").run();
  if (res.meta.changes === 0) return c.json({ error: "Not found" }, 404);
  await invalidateRules(c.env, userId);
  return c.body(null, 204);
});
```

### Ingestion hook

`POST /heartbeats` and `/heartbeats.bulk` call `loadRules` once per request, then `applyRules` per heartbeat. `null` results are filtered out before the batch INSERT; the per-item response still reports success at the original index (shape confirmed against the WakaTime-compatible contract in PR2).

## Phase 2 — Implementation Tasks

See [tasks.md](./tasks.md).

## Complexity Tracking

The only non-trivial piece is the ingestion hook touching an existing hot path. Mitigations: pure matcher (testable in isolation), KV cache (no per-request D1 read), regex excluded (bounded CPU), and a rule-count cap.
