# Quickstart: Goals Read Endpoints

This guide walks through manually verifying `GET /goals` and `GET /goals/{id}` once PR2 (implementation) is deployed.

## Prerequisites

- A deployed CloudTime worker. Single-user or multi-user mode both work — goal endpoints are user-scoped and not gated by `INSTANCE_MODE`.
- A user account with a valid API key (e.g. `ck_…`).
- One or more rows in the `goals` table for that user. Until the CRUD endpoints exist, seed manually via:

  ```bash
  wrangler d1 execute cloudtime-db --remote --command "
    INSERT INTO goals (id, user_id, title, type, delta, target_seconds,
                       is_enabled, is_snoozed, is_inverse, languages, editors, projects)
    VALUES (
      lower(hex(randomblob(16))),
      '<your user_id>',
      'Code 1 hour per day',
      'coding', 'day', 3600,
      1, 0, 0, NULL, NULL, NULL
    );
  "
  ```

- Recent heartbeats and at least one cron aggregation cycle so `summaries` has data.

## Scenario A — Empty list

Run as a freshly created user with no goal rows.

```bash
curl -sH "Authorization: Bearer $API_KEY" \
  https://cloudtime.example.dev/api/v1/users/current/goals
```

**Expected**: `{"data":[]}` with HTTP 200.

## Scenario B — List populated, no chart_data

Seed three goal rows (one disabled, one snoozed, one normal). Repeat the call.

**Expected**:
- 200 status, `data` array of length 3 ordered by `created_at` ascending.
- Each entry has `id`, `title`, `type`, `delta`, `target_seconds`, the three booleans, and `created_at` / `modified_at`.
- **No** entry has `chart_data` or top-level `status`.
- The disabled goal is still in the response.

## Scenario C — Single goal with chart_data (`type=coding`, `delta=day`)

Pick one of the seeded goal IDs and fetch it:

```bash
curl -sH "Authorization: Bearer $API_KEY" \
  https://cloudtime.example.dev/api/v1/users/current/goals/$GOAL_ID
```

**Expected**:
- `data.chart_data` is an array of length 7.
- Entries are ordered chronologically; the last entry's `range_status` is `pending`.
- Earlier entries' `range_status` is `success` if `actual_seconds >= target_seconds`, else `fail`.
- `data.status` matches the entry immediately before the pending one.
- Each `chart_data[i].range.date` is the YYYY-MM-DD label in the user's profile timezone.

## Scenario D — `type=languages` filter

Seed:

```bash
INSERT INTO goals (... type='languages', languages='["TypeScript","Go"]', ...);
```

**Expected**:
- `chart_data[i].actual_seconds` only counts summary rows where `language IN ('TypeScript','Go')` for that period.
- Adding heartbeats in Python during the test window MUST NOT bump any period's actual.

## Scenario E — `delta=week`

Seed with `delta='week', type='coding', target_seconds=18000` (5h/week).

**Expected**:
- `chart_data` length 7, one per ISO week starting Monday (in user's profile timezone).
- Each `range.start` is a Monday 00:00 local, each `range.end` is the following Monday 00:00 local.
- The pending period is the current week (whichever weekday it is when you call).

## Scenario F — `is_inverse=true` cap-style goal

Seed `is_inverse=1, target_seconds=1800` (cap of 30 min/day). On a day with `actual_seconds=600`:

**Expected**: that day's `range_status` is `success` (under cap).

On a day with `actual_seconds=3600`: `fail`.

## Scenario G — Snoozed goal

Seed with `is_snoozed=1`. Confirm:

**Expected**:
- `data.status` is `pending`.
- Individual `chart_data[i].range_status` values are computed normally (some may be `success`, others `fail`).

## Scenario H — Cross-user 404

As user A, attempt to fetch a goal ID that belongs to user B:

```bash
curl -sH "Authorization: Bearer $A_API_KEY" \
  https://cloudtime.example.dev/api/v1/users/current/goals/$B_GOAL_ID
```

**Expected**: 404 with `{"error":"Not found"}`. No information leaks that the ID exists.

## Scenario I — Unauthenticated request

```bash
curl -i https://cloudtime.example.dev/api/v1/users/current/goals
```

**Expected**: 401 Unauthorized.

## Scenario J — Timezone correctness

Set the user's profile timezone to `Asia/Tokyo`. Generate heartbeats just past local midnight (e.g. 2026-05-18 01:00 JST = 2026-05-17 16:00 UTC). Wait for cron aggregation.

**Expected**:
- The new heartbeats are attributed to the `2026-05-18` summary row.
- `chart_data` for a `delta=day` goal labels the most recent period as `2026-05-18` and treats `2026-05-17` as the previous (completed) period.

## Reverting / cleanup

There is nothing to revert. The read endpoints are pure SELECTs against existing tables. Removing the routes from `src/routes/goals.ts` and unmounting in `src/index.ts` would disable the feature without data loss.
