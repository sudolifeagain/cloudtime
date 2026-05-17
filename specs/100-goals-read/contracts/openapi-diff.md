# OpenAPI Diff

The Goals read surface already exists in `schemas/openapi.yaml` and the
referenced path files. PR1 tightens the response contract so the list and
single-goal endpoints expose distinct generated types.

## Files touched

1. `schemas/paths/goals/goals.yaml` — list endpoint description and response
   remains `Goal`.
2. `schemas/paths/goals/goal.yaml` — single-goal response now references
   `GoalWithChart`.
3. `schemas/components/schemas/Goal.yaml` — persisted goal fields only.
4. `schemas/components/schemas/GoalWithChart.yaml` — new schema requiring
   `chart_data` and `status`.

## Contract shape

### `GET /users/current/goals`

Returns `{"data": Goal[]}`. `Goal` contains only persisted columns:

- `id`, `title`, `type`, `delta`, `target_seconds`
- `is_enabled`, `is_snoozed`, `is_inverse`
- `languages`, `editors`, `projects`
- `created_at`, `modified_at`

The list response does not define `chart_data` or `status`.

### `GET /users/current/goals/{goal_id}`

Returns `{"data": GoalWithChart}`. `GoalWithChart` is `Goal` plus required:

- `chart_data`: exactly 7 entries in chronological order.
- `status`: `success`, `fail`, or `pending`.

Each chart entry requires:

- `actual_seconds`
- `goal_seconds`
- `range`
- `range_status`

## Generated-types impact

`npm run generate` updates `src/types/generated.ts` with a real response-type
split:

- `components["schemas"]["Goal"]` no longer includes `chart_data` or `status`.
- `components["schemas"]["GoalWithChart"]` requires `chart_data` and `status`.
- `operations["getGoals"]` returns `Goal[]`.
- `operations["getGoal"]` returns `GoalWithChart`.

This is intentional. The diff is no longer JSDoc-only because the OpenAPI
contract now encodes the list-vs-single response shape instead of relying on
description text alone.

## SDD compliance note

Per repository rules: PR1 lands SpecKit + schema + generated types. PR2 lands
the route handlers and chart helper. No runtime code in PR1.
