# Quickstart: Data Dumps (Export)

Manual verification once PR2 (implementation) is deployed.

## Prerequisites

```bash
export API_KEY=ck_xxx
export BASE=https://cloudtime.example.dev/api/v1
export H="Authorization: Bearer $API_KEY"
export DUMPS="$BASE/users/current/data_dumps"
```

Enable export by binding R2 in `wrangler.toml` and redeploying:

```toml
[[r2_buckets]]
binding = "R2_BUCKET"
bucket_name = "cloudtime-dumps"
```

## Scenario A — Export not configured (no R2)

With **no** `R2_BUCKET` bound:

```bash
curl -si "$DUMPS" -H "$H"
curl -siX POST "$DUMPS" -H "$H" -H "Content-Type: application/json" -d '{"type":"full"}'
```

**Expected**: both return **503** `{"error":"Data export not configured"}`; nothing is created.

## Scenario B — Request a full export

With R2 bound:

```bash
curl -sX POST "$DUMPS" -H "$H" -H "Content-Type: application/json" -d '{"type":"full"}'
```

**Expected**: 201 with `{data:{id, type:"full", status:"pending", created_at}}`.

## Scenario C — Dedupe in-flight requests

```bash
curl -sX POST "$DUMPS" -H "$H" -H "Content-Type: application/json" -d '{"type":"full"}'
```

**Expected**: returns the **same** pending dump `id` as Scenario B (no duplicate queued).

## Scenario D — Cron builds it

Wait for the hourly cron (or trigger a scheduled run in dev), then:

```bash
curl -s "$DUMPS" -H "$H"
```

**Expected**: the dump shows `status:"completed"` with a `download_url` and an `expires_at` ≈ 7 days out.

## Scenario E — Download

```bash
curl -sL "<download_url from Scenario D>" -H "$H" | jq 'keys'
```

**Expected**: the bundle JSON — for `full`, keys `["daily","heartbeats","summaries","user"]`; for `daily`, `["summaries","user"]`.

## Scenario F — Validation

```bash
curl -siX POST "$DUMPS" -H "$H" -H "Content-Type: application/json" -d '{"type":"everything"}'
```

**Expected**: 400 (unknown `type`).

## Scenario G — Expiry

After `expires_at` passes and the cron purge runs:

```bash
curl -s "$DUMPS" -H "$H"            # dump now status:"expired", no download_url
curl -si "<old download_url>" -H "$H"  # 404
```

**Expected**: the dump is `expired`; the old URL 404s; the R2 object is gone.

## Scenario H — Auth / isolation

```bash
curl -si "$DUMPS"   # no auth → 401 (when R2 bound; 503 takes precedence only after auth)
```

**Expected**: 401 unauthenticated. Another user never sees or downloads your dumps.

## Reverting / cleanup

Unbinding `R2_BUCKET` returns the feature to 503. Existing `data_dumps` rows
remain in D1; their R2 objects are purged on expiry. Removing the route +
cron hooks disables the feature without touching other data.
