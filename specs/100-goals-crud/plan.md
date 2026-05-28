# Implementation Plan: Goals CRUD Endpoints

**Branch**: `100-goals-crud` | **Date**: 2026-05-28 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/100-goals-crud/spec.md`

## Summary

Adds the mutation half of the Goals surface on top of the read path shipped in PR #96. Three new handlers (`createGoal`, `updateGoal`, `deleteGoal`) write to the existing `goals` D1 table. A small validation module turns a parsed request body into a validated, normalised row (or a 400). The `Goal` response shape is reused unchanged.

PR1 (this PR) lands the SpecKit artifacts, the OpenAPI additions (`POST` on `goals.yaml`, `PATCH` + `DELETE` on `goal.yaml`, new `GoalInput` / `GoalUpdate` request schemas), and the regenerated types. PR2 lands the handlers and tests after PR1 merges.

No DB migration, no new env var, no new dependency.

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers runtime)
**Primary Dependencies**: Hono >= 4.9.7
**Storage**: D1 (existing `goals` table only)
**Testing**: Vitest + workers pool; unit tests for the validation module, integration tests for all three endpoints against a seeded in-memory D1
**Target Platform**: Cloudflare Workers (edge compute)
**Project Type**: Web service (REST API)
**Performance Goals**: <10ms CPU per request — single-row INSERT/UPDATE/DELETE, at most one prior ownership SELECT for PATCH
**Constraints**: Workers free-tier CPU budget; mutations always scoped by `user_id`

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | OpenAPI updated first (this PR). `npm run generate` produces real new types (`createGoal`/`updateGoal`/`deleteGoal`, `GoalInput`, `GoalUpdate`). Handlers land only in PR2. |
| II. Cloudflare-Native | PASS | Pure D1 writes + `crypto.randomUUID()`. No new bindings, services, or KV. |
| III. Type Safety | PASS | Handlers consume `components["schemas"]["GoalInput"]`, `["GoalUpdate"]`, `["Goal"]` from `src/types/generated.ts`. No hand-edited types. |
| IV. Legal/Trademark | PASS | Original contract derived from our own schema. "WakaTime-compatible" stays in docs only. No source/asset borrowing. |
| V. Simplicity First | PASS | Reuses the read path's `rowToGoal` decoder; new code is one validation module + three thin handlers. No new abstraction beyond a `validateGoalInput` / `validateGoalUpdate` pair. |

## Project Structure

### Documentation (this feature)

```text
specs/100-goals-crud/
├── plan.md
├── spec.md
├── research.md            # immutability of type/delta, 404 vs 403, hard delete, validation placement
├── data-model.md          # uses existing goals table; no schema change; write-path field treatment
├── quickstart.md          # operator/QA scenarios for POST/PATCH/DELETE
├── tasks.md               # PR1/PR2 split
├── contracts/
│   └── openapi-diff.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root) — landed in PR2

```text
src/
├── routes/
│   └── goals.ts             # EXTEND: add createGoal / updateGoal / deleteGoal handlers
└── utils/
    └── goal-input.ts        # NEW: validateGoalInput(body) + validateGoalUpdate(body, existingType)
```

**Structure Decision**: The CRUD handlers live in the existing `src/routes/goals.ts` next to the read handlers (one router per resource, matching `heartbeats.ts`). Validation is split into a pure `src/utils/goal-input.ts` so it is unit-testable without D1 and mirrors the existing `goal-chart.ts` helper split.

## Phase 0 — Research Outputs

See [research.md](./research.md). Key decisions:
1. **`type` and `delta` are immutable** via PATCH (400 if present) — changing them silently reinterprets chart history.
2. **Cross-user / unknown target returns 404, not 403** — consistent with the read path; no goal-id existence leak.
3. **`DELETE` is a hard delete** returning 204 — `is_enabled=false` already covers "hide without deleting."
4. **Empty PATCH body is a 400**, not a silent no-op — surfaces client mistakes.
5. **Validation is a pure module** returning a discriminated result, keeping handlers thin and the rules unit-testable.
6. **Filter arrays are de-duplicated and stored as JSON TEXT**, matching what the read decoder already expects.
7. **Two request schemas** (`GoalInput` for create with required fields, `GoalUpdate` for PATCH with all-optional mutable fields) instead of one all-optional schema — the type system then encodes "create needs these, update may change those."

## Phase 1 — Design Outputs

### Validation module sketch

```ts
// src/utils/goal-input.ts
export type GoalType = "coding" | "languages" | "editors" | "projects";
export type GoalDelta = "day" | "week";
const MAX_TARGET_SECONDS = 604800;
const MAX_TITLE = 200;

export interface ValidatedGoalCreate {
  title: string;
  type: GoalType;
  delta: GoalDelta;
  target_seconds: number;
  is_enabled: boolean;
  is_snoozed: boolean;
  is_inverse: boolean;
  languages: string[];
  editors: string[];
  projects: string[];
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function validateGoalInput(body: unknown): ValidationResult<ValidatedGoalCreate> { … }

// existingType is needed so PATCH can enforce filter-array/type consistency
export function validateGoalUpdate(
  body: unknown,
  existingType: GoalType,
): ValidationResult<Partial<ValidatedGoalCreate>> { … }
```

### Handler sketch

```ts
// src/routes/goals.ts (added below the existing read handlers)
goals.post("/goals", async (c) => {
  const userId = c.get("userId");
  const parsed = validateGoalInput(await c.req.json().catch(() => null));
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const g = parsed.value;
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO goals (id, user_id, title, type, delta, target_seconds,
       is_enabled, is_snoozed, is_inverse, languages, editors, projects)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, userId, g.title, g.type, g.delta, g.target_seconds,
         g.is_enabled ? 1 : 0, g.is_snoozed ? 1 : 0, g.is_inverse ? 1 : 0,
         jsonOrNull(g.languages), jsonOrNull(g.editors), jsonOrNull(g.projects)).run();
  const row = await selectGoalRow(c.env.DB, id, userId);   // reuse read SELECT
  return c.json({ data: rowToGoal(row!) }, 201);
});

goals.patch("/goals/:goal_id", async (c) => {
  const userId = c.get("userId");
  const existing = await selectGoalRow(c.env.DB, c.req.param("goal_id"), userId);
  if (!existing) return c.json({ error: "Not found" }, 404);
  const parsed = validateGoalUpdate(await c.req.json().catch(() => null), existing.type as GoalType);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  // build SET clause from provided keys only, always append modified_at = datetime('now')
  …
  return c.json({ data: rowToGoal(updatedRow) });
});

goals.delete("/goals/:goal_id", async (c) => {
  const userId = c.get("userId");
  const res = await c.env.DB.prepare(
    `DELETE FROM goals WHERE id = ? AND user_id = ?`,
  ).bind(c.req.param("goal_id"), userId).run();
  if (res.meta.changes === 0) return c.json({ error: "Not found" }, 404);
  return c.body(null, 204);
});
```

### OpenAPI surface

Declared in this PR — see [contracts/openapi-diff.md](./contracts/openapi-diff.md). `POST` on the collection path, `PATCH` + `DELETE` on the item path, plus the new `GoalInput` / `GoalUpdate` request schemas. The create/update responses reuse `Goal`.

## Phase 2 — Implementation Tasks

See [tasks.md](./tasks.md).

## Complexity Tracking

No constitution violations. Complexity is bounded to input validation (string/number range checks + filter-array/type consistency). The write path is three single-row statements with `user_id` scoping; no transactions, no fan-out.
