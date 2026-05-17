# Quickstart: Verify OAuth Rate Limiting

This guide walks through manually verifying the rate-limit behavior introduced by this feature. It assumes PR2 (implementation) is deployed to a Cloudflare Workers environment with the new bindings configured.

## Prerequisites

- `wrangler` CLI authenticated against the target account.
- `wrangler.toml` contains the two `[[ratelimits]]` entries (`RATE_LIMIT_OAUTH_INITIATE`, `RATE_LIMIT_OAUTH_CALLBACK`).
- The worker is deployed (or running via `wrangler dev` with `--remote` so the rate-limiter binding is real, not stubbed).
- A test provider OAuth app is configured (the request never needs to complete OAuth — we just need a real provider parameter such as `github`).

## Scenario A — Initiate endpoint limit (10/60s)

```bash
WORKER_URL="https://cloudtime.example.dev"

# Send 12 requests as fast as the network allows; capture status only.
for i in $(seq 1 12); do
  curl -s -o /dev/null -w "%{http_code} " "$WORKER_URL/api/v1/auth/github"
done
echo
```

**Expected output**: `302 302 302 302 302 302 302 302 302 302 429 429`

Verification points:
1. The first 10 responses are 302 redirects to GitHub.
2. The 11th and 12th responses are 429.
3. `curl -i $WORKER_URL/api/v1/auth/github` after the limit hits returns:
   - `HTTP/2 429`
   - `retry-after: 60`
   - `cache-control: no-store`
   - body: `{"error":"Too many requests"}`
4. After 60 seconds, the same client can send another 10 requests successfully.

## Scenario B — Callback endpoint limit (5/60s)

```bash
WORKER_URL="https://cloudtime.example.dev"

for i in $(seq 1 7); do
  curl -s -o /dev/null -w "%{http_code} " "$WORKER_URL/api/v1/auth/github/callback?state=x&code=y"
done
echo
```

**Expected output**: `400 400 400 400 400 429 429`

Verification points:
1. The first 5 responses are 400 (invalid state — expected, since we passed `state=x`).
2. The 6th and 7th are 429 — the limiter rejects before state validation.
3. No KV entries named `oauth:state:x` are written for any of the 7 requests (state was invalid for all).

## Scenario C — Fail-open in local dev (no binding)

```bash
# Run worker locally WITHOUT the rate-limit binding configured.
wrangler dev --local

# In another terminal:
for i in $(seq 1 30); do
  curl -s -o /dev/null -w "%{http_code} " http://localhost:8787/api/v1/auth/github
done
echo
```

**Expected output**: All 30 are 302 (or 500 if OAuth secrets aren't set locally — but never 429).

Verification points:
1. Worker logs contain exactly one occurrence of:
   `[rate-limit] binding RATE_LIMIT_OAUTH_INITIATE is undefined; failing open for this isolate`
2. Subsequent requests in the same isolate do NOT re-emit the warning.

## Scenario D — IPv6 client truncation

Requires a client with a known IPv6 prefix. Using `curl --interface` from a `/48`-assigned host:

```bash
# IPv6 source: 2001:db8:abcd:1234::1
curl -6 "$WORKER_URL/api/v1/auth/github" # ×10 from the same /48
```

Verification points:
1. All 10 requests share a single rate-limit counter (i.e., the limiter sees them as one key).
2. After the 10th, the next request returns 429.
3. A request from a *different* /48 (e.g., `2001:db8:abcd:5678::1` if both prefixes are reachable) is **not** rate-limited.

## Scenario E — Log shape (PII check)

After triggering a 429 in any scenario above, inspect Worker logs:

```bash
wrangler tail
```

Expected log line shape:
```
[rate-limit] rejected endpoint=oauth-initiate rule=RATE_LIMIT_OAUTH_INITIATE key=203.0.113.0/24
```

Verification points:
1. The log line contains the truncated IP only, not the full IP.
2. No occurrences of `state=`, `code=`, `session=`, or any cookie value in the rejected request's logs.
3. Exactly one log line per rejected request (no duplicates).

## Reverting

To disable rate limiting without redeploying code:

```bash
# Comment out the [[ratelimits]] entries in wrangler.toml, then:
wrangler deploy
```

The middleware will fail-open (Scenario C behavior) and emit the one-time warning.

## Tuning thresholds

To change limits without code changes, edit the `simple` rule in `wrangler.toml`:

```toml
[[ratelimits]]
name = "RATE_LIMIT_OAUTH_INITIATE"
namespace_id = "1001"
  [ratelimits.simple]
  limit = 20 # was 10 — bumped to 20
  period = 60
```

Then redeploy. No code change required.
