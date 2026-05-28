# OpenAPI Diff

This PR adds the Goals mutation surface to `schemas/openapi.yaml` via the
existing goals path files, plus two new request-body schemas. The read
operations are unchanged.

## Files touched

1. `schemas/paths/goals/goals.yaml` — add `post` (`createGoal`).
2. `schemas/paths/goals/goal.yaml` — add `patch` (`updateGoal`) and `delete`
   (`deleteGoal`).
3. `schemas/components/schemas/GoalInput.yaml` — **new**, the create body.
4. `schemas/components/schemas/GoalUpdate.yaml` — **new**, the partial-update body.

No change to `Goal.yaml`, `GoalWithChart.yaml`, or the `getGoals` / `getGoal`
operations.

## Contract shape

### `POST /users/current/goals` → `createGoal`

- Request body (`required: true`): `GoalInput`.
- `201` → `{"data": Goal}` (persisted fields only; no `chart_data`).
- `400` → BadRequest (validation failure).
- `401` → Unauthorized.

`GoalInput` required: `title`, `type`, `delta`, `target_seconds`. Optional:
`is_enabled` (default true), `is_snoozed` (default false), `is_inverse`
(default false), `languages`, `editors`, `projects`. Constraints:
`title` 1–200 chars; `target_seconds` `(0, 604800]`; filter arrays must be
consistent with `type` (enforced server-side, documented in the schema
description).

### `PATCH /users/current/goals/{goal_id}` → `updateGoal`

- Request body (`required: true`): `GoalUpdate`.
- `200` → `{"data": Goal}` (merged state).
- `400` → BadRequest (empty body, immutable `type`/`delta`, or invalid field).
- `401` → Unauthorized.
- `404` → NotFound (cross-user or unknown id).

`GoalUpdate` has no required fields and **omits `type` and `delta`** — they
are immutable. Every other mutable field is optional.

### `DELETE /users/current/goals/{goal_id}` → `deleteGoal`

- `204` → no body.
- `401` → Unauthorized.
- `404` → NotFound (cross-user or unknown id).

## Generated-types impact

`npm run generate` adds to `src/types/generated.ts`:

- `components["schemas"]["GoalInput"]` — required `title`/`type`/`delta`/
  `target_seconds`, optional booleans + filter arrays.
- `components["schemas"]["GoalUpdate"]` — all optional, no `type`/`delta`.
- `operations["createGoal"]` — `GoalInput` request body, `201` returns `Goal`.
- `operations["updateGoal"]` — `GoalUpdate` request body, `200` returns `Goal`.
- `operations["deleteGoal"]` — `204` no content.
- The `/users/current/goals` path item gains `post`; the
  `/users/current/goals/{goal_id}` path item gains `patch` and `delete`.

No change to the existing `Goal` / `GoalWithChart` shapes or the read
operations.

## Why two request schemas

`GoalInput` (create) and `GoalUpdate` (PATCH) are deliberately distinct so the
generated types encode each verb's contract: create must set `type`/`delta`;
update cannot touch them. See [research.md](../research.md) Decision 7.

## SDD compliance note

Per repository rules: PR1 lands SpecKit + schema + generated types. PR2 lands
the route handlers (`createGoal`/`updateGoal`/`deleteGoal`) and the
`goal-input` validation helper. No runtime code in PR1.
