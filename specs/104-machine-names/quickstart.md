# Quickstart: Machine Names Endpoint

Manual verification once PR2 (implementation) is deployed.

## Prerequisites

```bash
export API_KEY=ck_xxx
export BASE=https://cloudtime.example.dev/api/v1
export H="Authorization: Bearer $API_KEY"
export HJ="$H
Content-Type: application/json"
```

## Scenario A — Devices register at ingestion

```bash
curl -sX POST "$BASE/users/current/heartbeats" -H "$H" -H "Content-Type: application/json" \
  -d '{"entity":"/a.ts","type":"file","time":'"$(date +%s)"',"machine":"laptop"}'
curl -sX POST "$BASE/users/current/heartbeats" -H "$H" -H "Content-Type: application/json" \
  -d '{"entity":"/b.ts","type":"file","time":'"$(date +%s)"',"machine":"desktop"}'
curl -sH "$H" "$BASE/users/current/machine_names"
```

**Expected**: `data` lists two machines (`desktop`, `laptop`) ordered by `last_seen_at` descending, each with `id`, `value`, `last_seen_at`, `created_at`, and `ip` (your address, or absent if not captured).

## Scenario B — Repeat device updates last_seen_at, no duplicate

```bash
sleep 1
curl -sX POST "$BASE/users/current/heartbeats" -H "$H" -H "Content-Type: application/json" \
  -d '{"entity":"/c.ts","type":"file","time":'"$(date +%s)"',"machine":"laptop"}'
curl -sH "$H" "$BASE/users/current/machine_names"
```

**Expected**: still two machines; `laptop` now sorts first (its `last_seen_at` advanced); no duplicate `laptop` row.

## Scenario C — X-Machine-Name header

```bash
curl -sX POST "$BASE/users/current/heartbeats" -H "$H" -H "Content-Type: application/json" \
  -H "X-Machine-Name: ci-runner" \
  -d '{"entity":"/d.ts","type":"file","time":'"$(date +%s)"'}'
curl -sH "$H" "$BASE/users/current/machine_names"
```

**Expected**: a `ci-runner` machine appears (the header is honoured when the body omits `machine`).

## Scenario D — No machine value registers nothing

```bash
curl -sX POST "$BASE/users/current/heartbeats" -H "$H" -H "Content-Type: application/json" \
  -d '{"entity":"/e.ts","type":"file","time":'"$(date +%s)"'}'
```

**Expected**: no new machine row (the list is unchanged from before this call).

## Scenario E — Hidden heartbeat registers no machine

With a custom `hide` rule (#101) matching `project=secret`:

```bash
curl -sX POST "$BASE/users/current/heartbeats" -H "$H" -H "Content-Type: application/json" \
  -d '{"entity":"/f.ts","type":"file","time":'"$(date +%s)"',"project":"secret","machine":"ghost"}'
curl -sH "$H" "$BASE/users/current/machine_names"
```

**Expected**: no `ghost` machine — a hidden heartbeat leaves no device trace.

## Scenario F — Bulk dedupes one device

```bash
curl -sX POST "$BASE/users/current/heartbeats.bulk" -H "$H" -H "Content-Type: application/json" -d '[
  {"entity":"/g.ts","type":"file","time":'"$(date +%s)"',"machine":"laptop"},
  {"entity":"/h.ts","type":"file","time":'"$(date +%s)"',"machine":"laptop"}
]'
```

**Expected**: `laptop` upserted once; still a single `laptop` row with an advanced `last_seen_at`.

## Scenario G — Cross-user isolation / auth

```bash
curl -si "$BASE/users/current/machine_names"   # no auth → 401
```

**Expected**: 401 unauthenticated. As another user, the list never includes your machines.

## Reverting / cleanup

Removing the ingestion upsert and the route disables the feature without data loss — existing `machine_names` rows remain, and `heartbeats.machine` is untouched.
