# Quickstart: validating the expanded rate limits

**Branch**: `159-rate-limit-expansion` | **Scope**: PR2 behavior (PR1 ships contract only)

## Prerequisites

- Deployed Worker with the two new `[[ratelimits]]` blocks (PR2's
  `wrangler.toml`), or the automated tests (stub bindings)
- Note: `wrangler dev` simulates rate-limit bindings locally; production
  behavior is per edge location and approximate (research header)

## Scenario 1 — flood is damped (User Story 1)

```bash
for i in $(seq 1 10); do curl -s -o /dev/null -w "%{http_code}\n" \
  https://your-worker.example.com/api/v1/auth/link/verify/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; done
```

**Expected**: the first ~5 answer `410` (unknown token), the rest `429`
with `Retry-After: 60`. Similarly, >30 stats requests in a minute from one
network start returning `429`.

## Scenario 2 — legitimate flows unaffected (User Story 2)

One verification click per emailed link and dashboard polling at the
cache's 5-minute granularity never approach the limits. With the bindings
absent (e.g. an operator who hasn't added the blocks), both endpoints
behave exactly as before, logging one `[rate-limit] … failing open`
warning per isolate.

## Scenario 3 — disabled stats stay uniform 404 (User Story 3)

With `PUBLIC_STATS = "false"`, any request volume to
`/api/v1/stats/{range}` returns `404` — never `429` (the gate precedes the
limiter and spends no budget).

## Automated validation (PR2)

Integration tests inject stub bindings via env overrides:
`{ limit: async () => ({ success: false }) }` → 429 path; success stub →
pass-through; a call-recording spy + `PUBLIC_STATS="false"` → 404 with the
limiter never consulted. Default suite (no bindings) pins fail-open.

```bash
npm run typecheck && npm test
```

Contract: [contracts/openapi-diff.md](./contracts/openapi-diff.md) ·
namespaces/order: [data-model.md](./data-model.md) · decisions:
[research.md](./research.md)
