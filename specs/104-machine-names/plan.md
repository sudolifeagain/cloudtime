# Implementation Plan: Machine Names Endpoint

**Branch**: `104-machine-names` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/104-machine-names/spec.md`

## Summary

Populate the `machine_names` registry at heartbeat ingestion and expose it with a single read endpoint, mirroring the `user_agents` feature (#105). Unlike user agents, `machine` is not foreign-keyed onto `heartbeats` — `machine_names` is an independent per-device registry upserted in the existing heartbeat `db.batch()`.

PR1 (this PR): SpecKit artifacts + OpenAPI description clarifications (the `getMachineNames` operation and `Machine` schema already exist). No runtime code. PR2: the upsert helper, the ingestion hook in `heartbeats.ts`, the read route, and tests.

No D1 migration, no new binding.

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers)
**Primary Dependencies**: Hono >= 4.9.7
**Storage**: D1 (`machine_names`, existing)
**Testing**: Vitest + workers pool — integration tests for ingestion population + the list endpoint
**Performance Goals**: <10ms CPU; one extra batched upsert per distinct machine
**Constraints**: fold the upsert into the existing heartbeat batch; no extra round-trip

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | OpenAPI operation already declared; PR1 clarifies descriptions, PR2 implements. `npm run generate` adds only JSDoc (no type-shape change). |
| II. Cloudflare-Native | PASS | One `INSERT … ON CONFLICT` added to the heartbeat `db.batch()`. IP from `CF-Connecting-IP`. No new bindings. |
| III. Type Safety | PASS | Read handler uses `components["schemas"]["Machine"]`. No hand-edited types. |
| IV. Legal/Trademark | PASS | Registry derived from our own schema; no upstream source/assets. |
| V. Simplicity First | PASS | Mirrors `user_agents`: one upsert helper + one list route. No mutation endpoints. |

## Project Structure

### Documentation (this feature)

```text
specs/104-machine-names/
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
│   └── machines.ts          # NEW: getMachineNames read handler (mirrors user-agents.ts)
├── utils/
│   └── machine.ts           # NEW: machineUpsertStmt(db, userId, value, ip) → D1PreparedStatement
├── routes/heartbeats.ts     # EXTEND: upsert distinct machines into the batch (single + bulk)
└── index.ts                 # NEW route mount
```

**Structure Decision**: Read route in `machines.ts` mirrors `user-agents.ts` almost verbatim. The upsert is exposed as a statement builder so it slots into the existing heartbeat batch (like `UPSERT_PROJECT_SQL`) rather than a separate write.

## Phase 0 — Research Outputs

See [research.md](./research.md). Key decisions:
1. `machine_names` is a **side registry**, not an FK on `heartbeats` — the raw `machine` string stays on the row.
2. **IP from `CF-Connecting-IP`**, stored verbatim, owner-private.
3. **Registration follows persistence** — invalid/hidden heartbeats register no machine.
4. **Upsert folded into the heartbeat batch**, deduped per distinct machine.
5. **List ordered by `last_seen_at` DESC**, mirroring `user_agents`.

## Phase 1 — Design Outputs

### Upsert statement builder

```ts
// src/utils/machine.ts
const MACHINE_UPSERT_SQL = `INSERT INTO machine_names (id, user_id, value, ip, last_seen_at, created_at)
VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
ON CONFLICT (user_id, value) DO UPDATE SET
  last_seen_at = datetime('now'),
  ip = excluded.ip`;

export function machineUpsertStmt(db: D1Database, userId: string, value: string, ip: string | null): D1PreparedStatement {
  return db.prepare(MACHINE_UPSERT_SQL).bind(crypto.randomUUID(), userId, value, ip);
}
```

### Ingestion hook (heartbeats.ts)

- Single POST: after rules (so a hidden heartbeat registers nothing), if `machine` present, push `machineUpsertStmt` into the insert batch with `ip = c.req.header("CF-Connecting-IP") ?? null`.
- Bulk POST: collect the **distinct** machine values across persisted (valid, non-hidden) items into a `Set`, push one upsert per distinct value (same request IP).

### Read route (mirrors user-agents.ts)

```ts
machines.get("/machine_names", async (c) => {
  const userId = c.get("userId");
  const { results } = await c.env.DB.prepare(
    `SELECT id, value, ip, last_seen_at, created_at FROM machine_names
      WHERE user_id = ? ORDER BY last_seen_at DESC`,
  ).bind(userId).all<MachineRow>();
  return c.json({ data: results.map(rowToMachine) });
});
```

### OpenAPI surface

Already declared. PR1 adds clarifying descriptions (ordering, ip privacy) — see [contracts/openapi-diff.md](./contracts/openapi-diff.md). No type-shape change.

## Phase 2 — Implementation Tasks

See [tasks.md](./tasks.md).

## Complexity Tracking

The only shared-path touch is the heartbeat ingestion batch, gated on a present `machine` value and deduped. No new failure modes beyond the existing batch.
