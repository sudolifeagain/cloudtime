# Quickstart: Goals CRUD Endpoints

This guide walks through manually verifying `POST`, `PATCH`, and `DELETE` on goals once PR2 (implementation) is deployed.

## Prerequisites

- A deployed CloudTime worker (single-user or multi-user — goal endpoints are user-scoped, not gated by `INSTANCE_MODE`).
- A user account with a valid API key (e.g. `ck_…`). Export it:

  ```bash
  export API_KEY=ck_xxx
  export BASE=https://cloudtime.example.dev/api/v1
  ```

## Scenario A — Create a minimal coding goal

```bash
curl -sX POST "$BASE/users/current/goals" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Code 1 hour per day","type":"coding","delta":"day","target_seconds":3600}'
```

**Expected**: HTTP 201, body `{"data": {...}}` where the goal has a UUID `id`, `is_enabled=true`, `is_snoozed=false`, `is_inverse=false`, empty `languages`/`editors`/`projects`, and `created_at` ≈ `modified_at`. Capture the id:

```bash
export GOAL_ID=<id from the response>
```

## Scenario B — Create a language-scoped goal

```bash
curl -sX POST "$BASE/users/current/goals" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"title":"5h TypeScript / week","type":"languages","delta":"week",
       "target_seconds":18000,"languages":["TypeScript"]}'
```

**Expected**: 201; response echoes `type:"languages"`, `languages:["TypeScript"]`.

## Scenario C — Create validation failures (each returns 400)

```bash
# empty title
-d '{"title":"   ","type":"coding","delta":"day","target_seconds":3600}'
# target out of range
-d '{"title":"x","type":"coding","delta":"day","target_seconds":0}'
-d '{"title":"x","type":"coding","delta":"day","target_seconds":700000}'
# unknown type / delta
-d '{"title":"x","type":"music","delta":"day","target_seconds":3600}'
-d '{"title":"x","type":"coding","delta":"fortnight","target_seconds":3600}'
# filter array on a coding goal
-d '{"title":"x","type":"coding","delta":"day","target_seconds":3600,"languages":["Go"]}'
# languages goal with no languages
-d '{"title":"x","type":"languages","delta":"day","target_seconds":3600}'
```

**Expected**: each returns HTTP 400 with `{"error":"<message naming the field>"}` and creates nothing.

## Scenario D — Edit mutable fields

```bash
curl -sX PATCH "$BASE/users/current/goals/$GOAL_ID" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{"target_seconds":7200,"is_snoozed":true}'
```

**Expected**: 200; `data.target_seconds=7200`, `data.is_snoozed=true`, all other fields unchanged, `modified_at` advanced beyond `created_at`.

## Scenario E — Reject immutable fields and empty body

```bash
# type is immutable
curl -sX PATCH "$BASE/users/current/goals/$GOAL_ID" -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" -d '{"type":"languages"}'
# delta is immutable
... -d '{"delta":"week"}'
# empty body
... -d '{}'
```

**Expected**: each returns HTTP 400 and changes nothing (re-`GET` the goal to confirm).

## Scenario F — Delete

```bash
curl -siX DELETE "$BASE/users/current/goals/$GOAL_ID" -H "Authorization: Bearer $API_KEY"
```

**Expected**: HTTP 204, empty body. A follow-up `GET $BASE/users/current/goals/$GOAL_ID` returns 404, and the goal is gone from `GET $BASE/users/current/goals`.

## Scenario G — Cross-user isolation

As user A, attempt to PATCH or DELETE a goal id that belongs to user B:

```bash
curl -siX DELETE "$BASE/users/current/goals/$B_GOAL_ID" -H "Authorization: Bearer $A_API_KEY"
curl -siX PATCH  "$BASE/users/current/goals/$B_GOAL_ID" -H "Authorization: Bearer $A_API_KEY" \
  -H "Content-Type: application/json" -d '{"title":"hijack"}'
```

**Expected**: both return 404. Re-reading the goal as user B shows it untouched.

## Scenario H — Unauthenticated

```bash
curl -siX POST   "$BASE/users/current/goals" -H "Content-Type: application/json" -d '{}'
curl -siX PATCH  "$BASE/users/current/goals/anything" -H "Content-Type: application/json" -d '{}'
curl -siX DELETE "$BASE/users/current/goals/anything"
```

**Expected**: each returns 401 and mutates nothing.

## Scenario I — Round-trip with the read path

Create a goal (Scenario A), then:

```bash
curl -sH "Authorization: Bearer $API_KEY" "$BASE/users/current/goals"          # appears in list
curl -sH "Authorization: Bearer $API_KEY" "$BASE/users/current/goals/$GOAL_ID"  # has chart_data
```

**Expected**: the newly created goal appears in the list (ordered by `created_at`) and the single-goal read returns it with computed `chart_data` of length 7.

## Reverting / cleanup

No data migration to revert. Removing the `post` / `patch` / `delete` handlers from `src/routes/goals.ts` disables the mutation surface without data loss; existing goals remain readable.
