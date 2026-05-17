# Implementation Plan: Goals Read Endpoints

**Branch**: `100-goals-read` | **Date**: 2026-05-17 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/100-goals-read/spec.md`

## Summary

Wires the two read endpoints declared in OpenAPI (`getGoals`, `getGoal`) to real handlers backed by the existing `goals` and `summaries` D1 tables. Adds a `src/utils/goal-chart.ts` helper that computes the 7-period `chart_data` for a single goal by selecting from the already-aggregated `summaries` table — no heartbeat scan.

No DB migration, no new env var, no new dependency. OpenAPI already declares the surface; PR1 confirms the surface and the new path/response shape is buildable, then PR2 ships the implementation.

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers runtime)
**Primary Dependencies**: Hono >= 4.9.7
**Storage**: D1 (existing `goals` and `summaries` tables only)
**Testing**: Vitest + workers pool; new unit tests for the chart-computation helper, integration tests for both endpoints against a seeded D1
**Target Platform**: Cloudflare Workers (edge compute)
**Project Type**: Web service (REST API)
**Performance Goals**: <10ms CPU per single-goal request (one joined SELECT against the goal row plus user timezone, one SELECT against summaries clamped to a 7-period window)
**Constraints**: D1 binding parameter limit (we stay well under), Workers free-tier CPU budget

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | OpenAPI already declares the operations. PR1 is spec-only; PR2 lands the handlers. `npm run generate` produces no type-shape change. |
| II. Cloudflare-Native | PASS | Pure D1 reads + existing `time-format` helpers. No new bindings or services. |
| III. Type Safety | PASS | Handlers use `components["schemas"]["Goal"]` and `components["schemas"]["GoalWithChart"]` from `src/types/generated.ts`. No hand-edited types. |
| IV. Legal/Trademark | PASS | "WakaTime-compatible" only in docs context. No source/asset borrowing. |
| V. Simplicity First | PASS | ≤200 LoC new code in `src/routes/goals.ts`; the chart helper is a single function over already-aggregated data. |

## Project Structure

### Documentation (this feature)

```text
specs/100-goals-read/
├── plan.md
├── spec.md
├── research.md            # week boundary, snoozed semantics, status-from-pending
├── data-model.md          # uses existing goals + summaries; no schema change
├── quickstart.md          # operator/QA scenarios
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
│   └── goals.ts                  # NEW: getGoals + getGoal handlers, mounted at /users/current
├── utils/
│   └── goal-chart.ts             # NEW: computeGoalChart(goal, summaries, userTz)
└── index.ts                      # NEW route mount: app.route("/api/v1/users/current", goals)
```

**Structure Decision**: `goals.ts` mirrors the existing route-file convention (`heartbeats.ts`, `summaries.ts`, `stats.ts`). Chart computation is split into a pure helper so it is unit-testable without D1.

## Phase 0 — Research Outputs

See [research.md](./research.md). Key decisions:
1. **Week boundary = ISO 8601 Monday-Sunday in the user's profile timezone.** Matches the cron aggregator's bucketing.
2. **7-period window** (current + 6 prior), chronologically ordered oldest-first.
3. **`is_snoozed` overrides top-level `status` to `pending`**, but does NOT pause chart computation — the actuals are still useful to the user.
4. **Per-period status uses `>=` (or `<=` when inverse) against the target**; equality is success.
5. **List omits `chart_data`** to keep the response small for any future client that paginates / batches.
6. **Cross-user 404** instead of 403 (do not leak goal ID existence).

## Phase 1 — Design Outputs

### Handler sketch

```ts
// src/routes/goals.ts
goals.get("/goals", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const { results } = await c.env.DB.prepare(
    `SELECT id, title, type, delta, target_seconds, is_enabled, is_snoozed,
            is_inverse, languages, editors, projects, created_at, modified_at
       FROM goals WHERE user_id = ? ORDER BY created_at ASC`,
  ).bind(userId).all<GoalRow>();
  return c.json({ data: results.map(rowToGoalListItem) });
});

goals.get("/goals/:id", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    `SELECT g..., u.timezone
       FROM goals g JOIN users u ON u.id = g.user_id
      WHERE g.id = ? AND g.user_id = ?`,
  ).bind(id, userId).first<GoalRow>();
  if (!row) return c.json({ error: "Not found" }, 404);

  const { ranges, summarySumQuery } = planChart(row, row.timezone);
  const totals = await c.env.DB.prepare(summarySumQuery).all<TotalsRow>();
  const goal = await assembleGoal(row, ranges, totals);
  return c.json({ data: goal });
});
```

### Chart-helper sketch

```ts
// src/utils/goal-chart.ts
export interface PeriodTotal { range: { date: string; start: string; end: string };
  actual_seconds: number;
}
export interface ChartEntry extends PeriodTotal {
  goal_seconds: number;
  range_status: "success" | "fail" | "pending";
}

export function buildRanges(delta: "day" | "week", userTz: string, count = 7): TimeRange[] { … }
export function classify(actual: number, target: number, isInverse: boolean,
                         isPending: boolean): "success" | "fail" | "pending" { … }
export function topStatus(entries: ChartEntry[], isSnoozed: boolean): "success" | "fail" | "pending" { … }
```

### OpenAPI surface

Already declared. PR1 tightens the response contract by keeping `Goal` as
the persisted-field list shape and adding `GoalWithChart` for the single-goal
response, where `chart_data` and `status` are required — see
[contracts/openapi-diff.md](./contracts/openapi-diff.md).

## Phase 2 — Implementation Tasks

See [tasks.md](./tasks.md).

## Complexity Tracking

No constitution violations. The complexity is bounded to chart computation (week boundaries + DST handling are already solved by `time-format.ts`).
