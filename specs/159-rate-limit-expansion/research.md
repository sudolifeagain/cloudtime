# Research: Rate limiting beyond the OAuth endpoints

**Branch**: `159-rate-limit-expansion` | **Date**: 2026-06-10

Sources consulted (2026-06-10): Cloudflare official documentation —
Workers Rate Limiting binding (`developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/`)
and the 2025-09-19 changelog entry announcing GA. Key platform facts:

- The `ratelimit` binding is **GA** (since 2025-09-19); the `[[ratelimits]]`
  configuration syntax used by this repo is the current, stable one.
- `period` must be **10 or 60** seconds; `limit` is a positive integer.
- `namespace_id` is a positive-integer string **unique per Cloudflare
  account**; bindings sharing a namespace share counters even across
  Workers. Existing: 1001 (OAuth initiate), 1002 (OAuth callback).
- Counting is **per edge location per key** and intentionally approximate
  ("not … an accurate accounting system").
- Cloudflare recommends non-IP keys (API keys, user ids) where available.

## D-1: Two new limiters, mirroring the 058 pattern

**Decision**: `RATE_LIMIT_LINK_VERIFY` (namespace 1003, 5/60 s) on
`GET /auth/link/verify/{token}`; `RATE_LIMIT_PUBLIC_STATS` (namespace 1004,
30/60 s) on `GET /stats/{range}`. Both reuse `rateLimitMiddleware`'s
truncated-IP keying (/24 v4, /48 v6) and fail-open-with-warning behavior.

**Rationale**: these are the only remaining unauthenticated endpoints that
convert anonymous requests into D1 work (verify: UPDATE+SELECT per
well-formed token; stats: 5-statement batch per cache miss, cache-key
rotation via the range param). 5/60 mirrors the OAuth callback limit
guarding the same email-click journey; 30/60 is 6× more generous because
dashboards/badges poll stats and NAT aggregation hits read endpoints
hardest — while still bounding a flood to ≤30 cache-missable reads per
network per minute per location. Non-IP keys are unavailable before
authentication, so the documented IP-key caveat is accepted exactly as 058
accepted it.

**Alternatives considered**: keying stats by `range` instead of IP —
rejected: a single attacker would exhaust the budget for everyone (global
denial); 10-second periods — rejected: same average rate with burstier
allowance and no operator benefit; tighter stats limit (10/60) — rejected:
public dashboards refreshing several widgets could plausibly burst past it.

## D-2: Verify limiter placement — after the 405 method check, before token work

**Decision**: the limiter runs after the method check (non-GET still gets
the clean, free 405) and before the `INSTANCE_MODE` check and all token
processing.

**Rationale**: the 405 branch is static — no D1, no token handling; making
method probes consume limiter budget would let an attacker POST-spam to
starve a legitimate user's single real click. Everything that can touch
the database sits behind the limiter.

**Alternatives considered**: route-level middleware ahead of the handler —
rejected: the route is a single `all()` handler so route middleware would
also meter non-GET probes; limiter before the method check — rejected per
the starvation argument above.

## D-3: Stats limiter placement — after the PUBLIC_STATS gate

**Decision**: on `getGlobalStats`, the #156 disabled gate stays first; the
limiter runs second; range validation, KV, and D1 follow.

**Rationale**: #156's contract is that a disabled instance is
indistinguishable from an absent endpoint — a `429` would be a new
observable revealing both existence and rate-limiting, and would spend
budget on an endpoint that costs nothing when disabled. SC-004/FR-002.

**Alternatives considered**: limiter first (uniform with other endpoints) —
rejected: leaks existence on disabled instances and wastes budget.

## D-4: The unauthenticated-401 blanket limiter is deferred to zone-level WAF

**Decision**: do not implement the issue's optional "coarse limiter for
unauthenticated 401s" as a Worker binding; document zone-level WAF
rate-limiting rules as the recommended tool instead
(`docs/cloudflare-constraints.md`, PR2).

**Rationale**: (1) the auth-failure path costs one indexed D1 point-read —
two orders of magnitude cheaper than the endpoints limited here; (2) the
binding is per-colo and approximate, a poor fit for a low-and-slow
distributed pattern across ~30 operations; (3) wiring a limiter into
`authMiddleware` would add a binding call to every failed request on every
endpoint and a `429` to every documented operation's contract — large
contract surface for marginal benefit; (4) zone-level WAF rate-limiting
rules operate before the Worker runs (no Worker invocation cost at all)
and operators can deploy them without code changes. This resolves the
issue's optional item by documented decision rather than code.

**Alternatives considered**: implementing it anyway — rejected per the
cost/benefit above; leaving it silently unaddressed — rejected: the issue
explicitly listed it, so the deferral must be recorded and documented.

## D-5: Testing strategy without real bindings

**Decision**: the workers test pool has no rate-limit bindings, so the
default suite exercises the fail-open path unchanged (SC-002). Limiter
behavior is tested with stub bindings injected via the established
per-request env-override pattern: `{ limit: async () => ({ success: false }) }`
for the 429 path, a success stub for pass-through, and a call-recording spy
to assert the disabled-stats gate never consults the limiter (D-3).

**Rationale**: deterministic, no new infrastructure, and matches how
`tests/security/rate-limit.test.ts` already unit-tests keying while
integration code relies on the `RateLimit` interface shape
(`src/types.ts`).
