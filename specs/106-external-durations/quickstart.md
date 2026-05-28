# Quickstart: External Durations

Manual verification once PR2 (implementation) is deployed.

## Prerequisites

```bash
export API_KEY=ck_xxx
export BASE=https://cloudtime.example.dev/api/v1
export H="Authorization: Bearer $API_KEY"
export HJ=(-H "$H" -H "Content-Type: application/json")
export EXT="$BASE/users/current/external_durations"
```

## Scenario A — Create one

```bash
curl -sX POST "$EXT" "${HJ[@]}" -d '{
  "external_id":"cal-evt-1","entity":"Standup","type":"app",
  "category":"meeting","start_time":'"$(date +%s)"',"end_time":'"$(($(date +%s)+900))"'}'
```

**Expected**: 201, `data` with a server `id`, `user_id`, `created_at`, echoing the input.

## Scenario B — Idempotent re-sync

```bash
# same external_id, new end_time
curl -sX POST "$EXT" "${HJ[@]}" -d '{
  "external_id":"cal-evt-1","entity":"Standup","type":"app",
  "start_time":'"$(date +%s)"',"end_time":'"$(($(date +%s)+1800))"'}'
curl -s "$EXT?date=$(date +%F)" -H "$H"
```

**Expected**: still a single `cal-evt-1` entry, now with the updated `end_time` (no duplicate).

## Scenario C — Validation (400)

```bash
# missing entity
-d '{"external_id":"x","type":"app","start_time":1,"end_time":2}'
# bad type
-d '{"external_id":"x","entity":"e","type":"meeting","start_time":1,"end_time":2}'
# end before start
-d '{"external_id":"x","entity":"e","type":"app","start_time":5,"end_time":1}'
```

**Expected**: each returns 400; nothing stored.

## Scenario D — Bulk create (all-or-nothing)

```bash
curl -sX POST "$EXT.bulk" "${HJ[@]}" -d '[
  {"external_id":"e1","entity":"A","type":"app","start_time":1717000000,"end_time":1717003600},
  {"external_id":"e2","entity":"B","type":"app","start_time":1717100000,"end_time":1717103600}
]'
```

**Expected**: 201 with `data` of length 2. Re-running with one invalid element returns 400 and writes nothing.

## Scenario E — List by day

```bash
curl -s "$EXT?date=2026-05-29" -H "$H"
curl -s "$EXT?date=2026-05-29&project=Personal" -H "$H"
```

**Expected**: entries whose `start_time` is on that local day, ascending; `project` filter narrows them. Missing `date` → 400.

## Scenario F — Bulk delete

```bash
ID=$(curl -s "$EXT?date=$(date +%F)" -H "$H" | jq -r '.data[0].id')
curl -siX DELETE "$EXT.bulk" "${HJ[@]}" -d '{"date":"'"$(date +%F)"'","ids":["'"$ID"'"]}'
```

**Expected**: 204; the entry is gone. Unknown ids in the list are ignored (still 204).

## Scenario G — Coding metrics unaffected

```bash
curl -s "$BASE/users/current/stats/last_7_days" -H "$H"
```

**Expected**: `/stats` totals are unchanged by the external durations created above — they are a parallel, non-coding series.

## Scenario H — Auth / isolation

```bash
curl -si "$EXT?date=2026-05-29"   # no auth → 401
```

**Expected**: 401. Another user never sees these durations.

## Reverting / cleanup

Removing the route + mount disables the feature without data loss. Existing rows remain; nothing else reads them.
