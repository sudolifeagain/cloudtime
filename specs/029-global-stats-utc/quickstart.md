# Quickstart: Global Stats Always Aggregate in UTC

Manual verification once PR2 (implementation) is deployed. The global stats
endpoint is unauthenticated.

## Prerequisites

```bash
export BASE=https://cloudtime.example.dev/api/v1
```

## Scenario A — Timezone is ignored

```bash
curl -s "$BASE/stats/last_7_days" | jq '.data.range.timezone'
curl -s "$BASE/stats/last_7_days?timezone=Asia/Tokyo" | jq '.data.range.timezone'
```

**Expected**: both print `"UTC"`, and the two `data` payloads are identical.

## Scenario B — Single cache entry per range

```bash
curl -s "$BASE/stats/last_30_days?timezone=America/New_York" >/dev/null
curl -s "$BASE/stats/last_30_days?timezone=Europe/Paris"     >/dev/null
curl -s "$BASE/stats/last_30_days"                            >/dev/null
```

**Expected**: all three are served from one cache entry (`global-stats:last_30_days`); varying the timezone does not create new entries or force recomputation (observable as stable latency / no extra D1 aggregation in logs).

## Scenario C — Invalid timezone does not error

```bash
curl -si "$BASE/stats/last_7_days?timezone=Not/AZone" | head -1
```

**Expected**: `200` (the timezone is ignored, not validated). Contrast with the **authenticated** per-user endpoint, which still 400s on an invalid timezone.

## Scenario D — Invalid range still 400s

```bash
curl -si "$BASE/stats/since_forever" | head -1
```

**Expected**: `400` (range validation is unchanged).

## Scenario E — Per-user stats unaffected

```bash
curl -s "$BASE/users/current/stats/last_7_days?timezone=Asia/Tokyo" -H "Authorization: Bearer $API_KEY" | jq '.data.range.timezone'
```

**Expected**: `"Asia/Tokyo"` (or the user's profile timezone) — the authenticated endpoint still honours timezone; only the global endpoint is fixed to UTC.

## Reverting / cleanup

Pure handler change. Reverting restores the previous timezone-aware global
behaviour; no data or schema impact. Old cache keys expire within 5 minutes.
