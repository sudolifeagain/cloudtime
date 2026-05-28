# Quickstart: Custom Rules CRUD + Heartbeat Remap

Manual verification once PR2 (implementation) is deployed.

## Prerequisites

```bash
export API_KEY=ck_xxx
export BASE=https://cloudtime.example.dev/api/v1
export H="Authorization: Bearer $API_KEY"
export HJ="$H
Content-Type: application/json"
```

## Scenario A — Replace rule set

```bash
curl -sX PUT "$BASE/users/current/custom_rules" -H "$H" -H "Content-Type: application/json" -d '[
  {"action":"change","source":"project","operation":"equals","source_value":"cloudtime-old",
   "destination":"project","destination_value":"cloudtime"},
  {"action":"hide","source":"project","operation":"starts_with","source_value":"work/"}
]'
```

**Expected**: 200, `data` has two rules, each with a server `id` and `created_at`, `priority` 0 and 1.

## Scenario B — List (ordered by priority)

```bash
curl -sH "$H" "$BASE/users/current/custom_rules"
```

**Expected**: the two rules in ascending priority order.

## Scenario C — Validation failures (400, set unchanged)

```bash
# change rule missing destination_value
-d '[{"action":"change","source":"project","operation":"equals","source_value":"x","destination":"project"}]'
# unknown action
-d '[{"action":"drop","source":"project","operation":"equals","source_value":"x"}]'
# empty source_value
-d '[{"action":"hide","source":"project","operation":"equals","source_value":""}]'
```

**Expected**: each returns 400; a follow-up `GET` still shows the Scenario A rules (unchanged).

## Scenario D — Empty array clears all

```bash
curl -sX PUT "$BASE/users/current/custom_rules" -H "$H" -H "Content-Type: application/json" -d '[]'
curl -sH "$H" "$BASE/users/current/custom_rules"
```

**Expected**: PUT 200; GET returns `{"data":[]}`.

## Scenario E — `change` rewrites an ingested heartbeat

Re-apply Scenario A, then:

```bash
curl -sX POST "$BASE/users/current/heartbeats" -H "$H" -H "Content-Type: application/json" \
  -d '{"entity":"/x.ts","type":"file","time":'"$(date +%s)"',"project":"cloudtime-old"}'
# then read today's heartbeats:
curl -sH "$H" "$BASE/users/current/heartbeats?date=$(date +%F)"
```

**Expected**: the stored heartbeat has `project":"cloudtime"` (remapped), not `cloudtime-old`.

## Scenario F — `hide` drops an ingested heartbeat

```bash
curl -siX POST "$BASE/users/current/heartbeats" -H "$H" -H "Content-Type: application/json" \
  -d '{"entity":"/y.ts","type":"file","time":'"$(date +%s)"',"project":"work/secret"}'
curl -sH "$H" "$BASE/users/current/heartbeats?date=$(date +%F)"
```

**Expected**: the POST reports success (no error), but the heartbeat does **not** appear in the day's list — it was hidden. The response gives no indication which item was dropped.

## Scenario G — Bulk mix

```bash
curl -sX POST "$BASE/users/current/heartbeats.bulk" -H "$H" -H "Content-Type: application/json" -d '[
  {"entity":"/a.ts","type":"file","time":'"$(date +%s)"',"project":"cloudtime-old"},
  {"entity":"/b.ts","type":"file","time":'"$(date +%s)"',"project":"work/secret"},
  {"entity":"/c.ts","type":"file","time":'"$(date +%s)"',"project":"keep"}
]'
```

**Expected**: per-item responses in order; reading back shows `/a.ts` stored as `project=cloudtime`, `/b.ts` absent (hidden), `/c.ts` stored as `keep`.

## Scenario H — Delete one rule

```bash
RULE_ID=$(curl -sH "$H" "$BASE/users/current/custom_rules" | jq -r '.data[0].id')
curl -siX DELETE "$BASE/users/current/custom_rules/$RULE_ID" -H "$H"
```

**Expected**: 204; the rule is gone from `GET`; subsequent ingestion no longer applies it (cache invalidated).

## Scenario I — Cross-user 404

```bash
curl -siX DELETE "$BASE/users/current/custom_rules/$OTHER_USERS_RULE_ID" -H "$H"
```

**Expected**: 404; the other user's rule is untouched.

## Scenario J — Unauthenticated

```bash
curl -si "$BASE/users/current/custom_rules"   # GET, no auth
```

**Expected**: 401.

## Reverting / cleanup

`PUT []` clears all rules; once cleared, ingestion is a no-op pass-through. Removing the router mount and the ingestion hook disables the feature without data loss (existing heartbeats are unaffected — rules only act at ingestion time).
