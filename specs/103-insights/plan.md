# Implementation Plan: Insights Endpoint

**Branch**: `103-insights` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/103-insights/spec.md`

## Summary

Wire the declared `getInsight` operation to a read handler that derives each insight type from the `summaries` table over a resolved range. Reuse `resolveStatsRange` for the range vocabulary and the existing duration-formatting helpers for `digital`/`text`. No new table, no raw-heartbeat scan.

PR1 (this PR): SpecKit artifacts + OpenAPI description (per-type field mapping, range vocab, reserved query params) plus the explicit 400 response for invalid inputs. The operation, `Insight`, `SummaryItem`, and `TimeRange` schemas already exist, so the 200 response shape is unchanged. PR2: the route + a small insight-builder helper + tests.

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers)
**Primary Dependencies**: Hono >= 4.9.7
**Storage**: D1 (`summaries`, existing)
**Testing**: Vitest + workers pool — unit tests for the pure shaping helpers, integration tests per insight type against a seeded `summaries` fixture
**Performance Goals**: <10ms CPU — one indexed `GROUP BY` over the date window + in-memory shaping
**Constraints**: summaries day-granularity only (no `hours`); Workers CPU budget

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | Operation already declared; PR1 clarifies descriptions, PR2 implements. `npm run generate` is JSDoc-only. |
| II. Cloudflare-Native | PASS | Pure D1 reads over `summaries`; reuses `resolveStatsRange`. No new bindings/tables. |
| III. Type Safety | PASS | Handler uses `components["schemas"]["Insight"]` / `["SummaryItem"]` / `["TimeRange"]`. No hand-edited types. |
| IV. Legal/Trademark | PASS | Derived from our own schema + aggregated data; no upstream source/assets. |
| V. Simplicity First | PASS | One route + one pure builder reusing existing range + formatting helpers. `hours` deferred to avoid an hourly-aggregate detour. |

## Project Structure

### Documentation (this feature)

```text
specs/103-insights/
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
│   └── insights.ts          # NEW: getInsight handler (validate type+range, dispatch)
├── utils/
│   └── insights.ts          # NEW: pure builders (dimension items, days, best_day, daily_average, weekday)
└── index.ts                 # NEW route mount
```

**Structure Decision**: A thin route that validates `insight_type` + resolves `range`, then dispatches to a pure builder in `utils/insights.ts` that takes rows + range and returns the `Insight` shape. The builder is unit-testable without D1; the route owns the single SELECT.

## Phase 0 — Research Outputs

See [research.md](./research.md). Key decisions:
1. **Summaries-only**, no raw scan; **`hours` deferred** (needs hourly aggregate).
2. **Range reuse** via `resolveStatsRange` (same vocabulary as `/stats`).
3. **`daily_average` divides by active days**, not calendar days (avoids `all_time` dilution).
4. **`weekday` returned as `items[]`** (no weekday-specific schema field), mean per active weekday occurrence.
5. **NULL dimension → `"Unknown"`** bucket.
6. **`timeout`/`writes_only`/`weekday` reserved** (summaries can't honour them).

## Phase 1 — Design Outputs

### Route sketch

```ts
const INSIGHT_TYPES = new Set(["weekday","days","best_day","daily_average",
  "projects","languages","editors","categories","machines","operating_systems"]);
const DIMENSION_COLUMN: Record<string,string> = {
  projects:"project", languages:"language", editors:"editor",
  categories:"category", machines:"machine", operating_systems:"operating_system" };

insights.get("/insights/:insight_type/:range", async (c) => {
  const type = c.req.param("insight_type");
  if (!INSIGHT_TYPES.has(type)) return c.json({ error: "Invalid insight_type" }, 400);
  const tz = await getUserTimezone(c);
  const resolved = resolveStatsRange(c.req.param("range"), tz);
  if (!resolved) return c.json({ error: "Invalid range" }, 400);
  const rows = await c.env.DB.prepare(
    `SELECT date, project, language, editor, operating_system, category, machine,
            SUM(total_seconds) AS total_seconds
       FROM summaries WHERE user_id = ? AND date BETWEEN ? AND ?
      GROUP BY date, project, language, editor, operating_system, category, machine`,
  ).bind(userId, resolved.start, resolved.end).all<SummaryRow>();
  return c.json({ data: buildInsight(type, rows.results, resolved, tz) });
});
```

(For dimension insights the builder can also be driven by a tighter per-column `GROUP BY`; the single grouped read above is enough for all types and stays one query.)

### Builder sketch (pure, unit-testable)

```ts
// src/utils/insights.ts
export function buildInsight(type, rows, range, tz): Insight { … }
// helpers: groupByColumn → SummaryItem[] (percent + formatting via formatDuration),
//          byDate → days[] / best_day / daily_average,
//          byWeekday → items[] (English weekday names, mean per active occurrence)
```

Formatting (`digital`, `text`, `hours/minutes/seconds`) reuses the same helper `/stats` uses for `SummaryItem`.

### OpenAPI surface

Already declared. PR1 adds the per-type field-mapping description and explicit 400 response - see [contracts/openapi-diff.md](./contracts/openapi-diff.md). No request parameter or 200 response shape change.

## Phase 2 — Implementation Tasks

See [tasks.md](./tasks.md).

## Complexity Tracking

Bounded: one grouped SELECT + pure in-memory shaping. The only subtle parts (active-day averaging, weekday derivation) live in the pure builder with direct unit tests.
