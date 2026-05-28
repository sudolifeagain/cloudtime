# OpenAPI Diff

The `getInsight` operation and the `Insight` / `SummaryItem` / `TimeRange`
schemas already existed in `schemas/openapi.yaml`. This PR clarifies the
operation contract without changing request parameters or the 200 response
schema.

## Files touched

1. `schemas/paths/insights/insights.yaml` — add a `description` to
   `getInsight` documenting the per-type response-field mapping, the `range`
   vocabulary, the absence of an `hours` type, and the reserved
   `timeout`/`writes_only`/`weekday` query params.
2. Add an explicit `400` response for invalid `insight_type` or `range`, using
   the shared `BadRequest` response component.

No schema field changes, no new operation, no enum change, no 200 response
shape change.

## Contract

### `GET /users/current/insights/{insight_type}/{range}` → `getInsight`

- `insight_type` (path) in `weekday | days | best_day | daily_average |
  projects | languages | editors | categories | machines |
  operating_systems`. (No `hours` - day-granularity source.)
- `range` (path): `last_7_days | last_30_days | last_6_months | last_year |
  all_time | YYYY | YYYY-MM`.
- `timeout`, `writes_only`, `weekday` (query): accepted, **reserved** (not
  applied in the first cut).
- `200` -> `{ data: Insight }`; invalid `insight_type` / `range` -> `400`;
  `401` unauthenticated.

### Which `Insight` field each type populates

| `insight_type` | Field |
|---|---|
| `days` | `days[]` |
| `best_day` | `best_day` |
| `daily_average` | `daily_average` |
| `weekday` | `items[]` (one per weekday) |
| `projects` / `languages` / `editors` / `categories` / `machines` / `operating_systems` | `items[]` |

`data.type` echoes the requested type; `data.range` is the resolved
`TimeRange`.

## Generated-types impact

`npm run generate` adds JSDoc to `operations["getInsight"]` and exposes the
documented 400 response. The TypeScript types for `Insight`, `SummaryItem`,
`TimeRange`, operation parameters, and the 200 response are unchanged.

## SDD compliance note

PR1 lands SpecKit + the description + regenerated types (JSDoc only). PR2 lands
the route handler, the pure insight builder, and tests. No runtime code in PR1.
