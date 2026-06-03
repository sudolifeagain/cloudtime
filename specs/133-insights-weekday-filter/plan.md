# Implementation Plan: `weekday` filter for the `days` insight

**Branch**: `133-insights-weekday-filter` | **Date**: 2026-06-04 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/133-insights-weekday-filter/spec.md`

## Summary

Graduate the already-declared `weekday` query parameter from *reserved* to *applied*, for the `days` insight type only. When set, `days[]` is restricted to dates whose day-of-week matches; for every other insight type the parameter stays ignored. Reuse the existing weekday derivation (0=Sunday … 6=Saturday) so `days` filtering and the `weekday` insight agree. No new table, no schema migration, no raw-heartbeat scan.

**PR1 (this PR)**: SpecKit artifacts + OpenAPI description updates (operation prose + the `weekday` parameter description) + regenerated types. No request/response *shape* change — the parameter already exists as `string` — so `npm run generate` is JSDoc-only.

**PR2 (after PR1 merges)**: parse + validate `weekday` in the route, thread it into `buildInsight`, filter the `days` branch, add unit + integration tests.

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers)
**Primary Dependencies**: Hono >= 4.9.7
**Storage**: D1 (`summaries`, existing) — read-only, no change
**Testing**: Vitest + workers pool — unit tests for the pure filter in `buildInsight`; integration tests for the endpoint (filtered/unfiltered, name/int equivalence, 400s, non-`days` ignore)
**Performance Goals**: <10ms CPU — unchanged single grouped SELECT + an O(active-days) in-memory filter
**Constraints**: summaries day-granularity; reuse existing `weekdayOf` (no new timezone logic)

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | Parameter already declared; PR1 clarifies its description (reserved → applied) and regenerates; PR2 implements. `npm run generate` is JSDoc-only. |
| II. Cloudflare-Native | PASS | No new SELECT, no new table/binding; in-memory filter over already-materialised per-date totals. Stays within the existing CPU budget. |
| III. Type Safety | PASS | Handler keeps using `components["schemas"]["Insight"]`; parameter remains `string` in generated types. No hand-edited types. |
| IV. Legal/Trademark | PASS | Convention chosen for internal consistency with our own `weekday` insight; no WakaTime source consulted. |
| V. Simplicity First | PASS | One parameter activated, one branch of one pure builder touched. `timeout`/`writes_only` deliberately left out of scope. |

## Project Structure

### Documentation (this feature)

```text
specs/133-insights-weekday-filter/
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
│   └── insights.ts   # CHANGE: read & validate `weekday` query (only enforced for `days`); pass into buildInsight
└── utils/
    └── insights.ts   # CHANGE: buildInsight accepts an optional weekday filter; applied in the `days` branch via the existing weekdayOf()
```

**Structure Decision**: Keep the route thin — it parses `weekday` into a normalised `0–6 | null`, returns 400 only when `insight_type === "days"` and the value is present-but-invalid, and passes the resolved filter to `buildInsight`. The pure builder applies the filter inside the `days` branch using the existing `weekdayOf` helper, so it stays unit-testable without D1. No other insight branch reads the filter.

## Phases

- **PR1 — Spec + Design (this PR)**: author the SpecKit set; update `schemas/paths/insights/insights.yaml` (operation description + `weekday` parameter description); `npm run generate`; `npm run typecheck`.
- **PR2 — Implementation**: route parse/validate + builder filter + unit & integration tests; `npm test` green; open PR referencing #133 and PR1.

## Risks & Mitigations

- **Convention mismatch with clients expecting ISO weekdays** → documented explicitly in the parameter description and `research.md` D-1; accepting names sidesteps integer-convention confusion for most callers.
- **Regression for clients already sending `weekday` on non-`days` types** → FR-007 + US3 lock in "ignore where unused"; integration test asserts identical payloads.
- **Type drift** → parameter intentionally stays `string`; `npm run generate` diff reviewed to confirm it is JSDoc-only.
