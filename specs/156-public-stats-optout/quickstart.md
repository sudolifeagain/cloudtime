# Quickstart: validating the public global stats opt-out

**Branch**: `156-public-stats-optout` | **Scope**: PR2 behavior (PR1 ships contract only)

## Prerequisites

- `npm install`, local D1 initialized (`npm run db:init`)
- Some seeded activity (any heartbeats aggregated into `summaries`), or run
  against the integration test fixtures

## Scenario 1 — default: endpoint enabled, behavior unchanged

```bash
npx wrangler dev
curl -i http://localhost:8787/api/v1/stats/last_7_days
```

**Expected**: `200` (or `202` while aggregation is pending) with the
`GlobalStats` body; `400` for an invalid range such as `not_a_range`.
Identical to the current release.

## Scenario 2 — disabled: every request is 404, no work performed

Add to `wrangler.toml` `[vars]` (or use `--var`):

```toml
PUBLIC_STATS = "false"
```

```bash
npx wrangler dev
curl -i http://localhost:8787/api/v1/stats/last_7_days   # valid range
curl -i http://localhost:8787/api/v1/stats/not_a_range   # invalid range
```

**Expected**: both return `404` with the standard error body
(`{"error": "..."}`); the responses are indistinguishable, and no
`global-stats:*` KV entry is written (verifiable in tests via the KV
binding; locally via `wrangler kv key list`).

## Scenario 3 — scope: nothing else is affected

With `PUBLIC_STATS = "false"` still set:

```bash
curl -i http://localhost:8787/api/v1/health              # 200
curl -i http://localhost:8787/api/v1/editors             # 200
curl -i http://localhost:8787/api/v1/program_languages   # 200
curl -i -H "Authorization: Bearer $CK_API_KEY" \
  http://localhost:8787/api/v1/users/current/stats/last_7_days   # 200/202
```

**Expected**: all unchanged — the switch governs only the unauthenticated
global aggregate.

## Automated validation (PR2)

Integration tests in `tests/integration/global-stats.test.ts` cover the
matrix above by passing `{ PUBLIC_STATS: "false" }` (and `"true"`, garbage
values, unset) as per-request env overrides — the same pattern
`tests/integration/pending-link-verify.test.ts` uses for `INSTANCE_MODE`.
Run with:

```bash
npm run typecheck && npm test
```

Contract references: [contracts/openapi-diff.md](./contracts/openapi-diff.md)
· decisions: [research.md](./research.md) · config surface:
[data-model.md](./data-model.md)
