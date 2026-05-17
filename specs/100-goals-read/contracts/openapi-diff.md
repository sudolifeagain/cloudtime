# OpenAPI Diff

The Goals read surface already exists in `schemas/openapi.yaml` and the
referenced path files. PR1 makes only **description-level** tightening to
make the two endpoints' response shape contract precise.

## Files touched

1. `schemas/paths/goals/goals.yaml` — list endpoint description.
2. `schemas/paths/goals/goal.yaml` — single-goal endpoint description.
3. `schemas/components/schemas/Goal.yaml` — clarifies which fields are
   populated where.

## Diff 1 — `goals.yaml`

Add a `description` block stating the list endpoint omits `chart_data` and
`status` (matches FR-002).

```diff
 get:
   operationId: getGoals
   tags:
     - goals
   summary: List user's goals
+  description: |
+    Returns the authenticated user's goals ordered by `created_at` ascending.
+    Each entry includes only the persisted Goal fields. `chart_data` and
+    `status` are NOT computed for the list endpoint — clients that need
+    per-period progress must request each goal individually via
+    `GET /users/current/goals/{goal_id}`.
   responses:
     '200':
       description: List of goals
```

## Diff 2 — `goal.yaml`

Add a `description` block explaining the chart's 7-period window and the
timezone source.

```diff
 get:
   operationId: getGoal
   tags:
     - goals
   summary: Get a single goal with chart data
+  description: |
+    Returns a single goal owned by the authenticated user, augmented with
+    `chart_data` (the most recent 7 periods of actual vs target activity)
+    and top-level `status` (the most recently completed period's outcome,
+    forced to `pending` if the goal is snoozed).
+
+    Period boundaries use the user's profile timezone (`users.timezone`).
+    Day periods span local calendar days. Week periods span ISO 8601
+    Monday-Sunday weeks in the user's timezone.
+
+    Requests for a goal owned by a different user return 404 (not 403) to
+    avoid leaking goal-id existence.
```

## Diff 3 — `Goal.yaml`

Annotate `chart_data` and `status` as "populated only by `GET /goals/{id}`".

```diff
   chart_data:
     type: array
+    description: |
+      Populated only by `GET /users/current/goals/{goal_id}`. Always 7 entries
+      in chronological order; the last entry is always `range_status: pending`.
     items:
       …
   status:
     type: string
+    description: |
+      Populated only by `GET /users/current/goals/{goal_id}`. Mirrors the
+      `range_status` of the most recently completed period unless the goal
+      is snoozed, in which case it is forced to `pending`.
     enum:
       - success
       - fail
       - pending
```

## Generated-types impact

`npm run generate` emits JSDoc-only changes in `src/types/generated.ts`:
- Two operation descriptions and three field descriptions.
- No new types, no removed types, no type shape changes.

The diff must remain JSDoc-only; if `tsc` flags any type-shape change, the
description text was probably mis-edited and PR1 is blocked until the change
is narrowed.

## SDD compliance note

Per CLAUDE.md: PR1 lands SpecKit + schema (description only). PR2 lands
the route handlers and the chart helper. No runtime code in PR1.
