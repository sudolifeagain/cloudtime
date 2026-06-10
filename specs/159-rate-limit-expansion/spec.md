# Feature Specification: Rate limiting beyond the OAuth endpoints

**Feature Branch**: `159-rate-limit-expansion`
**Created**: 2026-06-10
**Status**: Draft
**Input**: GitHub Issue #159. Only the OAuth initiate/callback endpoints carry rate-limit bindings today (`specs/058-oauth-rate-limiting/`). Two other unauthenticated-reachable paths remain unthrottled at the application layer and each costs database work per request. Found in the 2026-06-10 security audit.

## Background

Two endpoints can be driven by anyone who knows the instance URL:

- **`GET /api/v1/auth/link/verify/{token}`** — the out-of-band email
  verification route. The #152 format pre-check rejects malformed tokens
  before any database access, but every *well-formed* unknown token still
  costs a database write attempt plus a follow-up read. Legitimate usage is
  one click per emailed link.
- **`GET /api/v1/stats/{range}`** — the public global stats endpoint. A
  cache miss fans out to a five-statement database batch, and each distinct
  range value owns its own five-minute cache entry, so an attacker can
  rotate ranges to dodge the cache.

This feature extends the existing edge rate-limiting pattern (same
middleware, same truncated-IP keying, same fail-open-with-warning behavior
when a binding is missing) to those two endpoints:

| Endpoint | Limit | Basis |
|---|---|---|
| `GET /auth/link/verify/{token}` | 5 / 60 s per client network | mirrors the OAuth callback limit; one click per email is the entire legitimate flow |
| `GET /stats/{range}` | 30 / 60 s per client network | generous for dashboards/badges polling a 5-minute-cached endpoint |

Verified against the platform's official documentation (2026-06-10, recorded
in `research.md`): the rate-limiting binding is generally available, periods
of 60 seconds are supported, limits are approximate and scoped per
edge location per key — adequate for abuse damping, not precise accounting.

The issue's optional third item — a coarse limiter for unauthenticated `401`
responses across all API-key endpoints — is **deferred** with recorded
rationale (research D-4): the auth-failure path costs only one indexed
point-read, the binding's per-location approximation fits poorly over
dozens of operations, and broad-spectrum throttling is the job of zone-level
WAF rules, which operators can layer on without code changes.

Ordering rule fixed by design: on the public stats endpoint, the
`PUBLIC_STATS=false` disabled gate (#156) runs **before** the limiter — a
disabled instance answers `404` always (never `429`) and spends nothing.

This spec covers PR1 of the SpecKit 2-PR workflow: specification artifacts
plus the documented `429` response on the two operations and regenerated
types. Bindings and wiring follow in PR2.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Abusive request floods are damped (Priority: P1)

As an instance operator, I want repeated anonymous hammering of the verify
and public-stats endpoints to be rejected at the edge so it cannot translate
into unbounded database work.

**Why this priority**: This is the audit finding — both endpoints turn
anonymous requests into database operations.

**Independent Test**: With a binding configured (or stubbed in tests),
requests beyond the limit receive `429` with a `Retry-After` header and
perform no database or cache work.

**Acceptance Scenarios**:

1. **Given** the verify endpoint's limiter reports the limit exceeded, **When** a request arrives, **Then** the response is `429` (standard error body + `Retry-After`) and no token lookup occurs.
2. **Given** the public-stats limiter reports the limit exceeded, **When** a request arrives, **Then** the response is `429` and neither the cache nor the database is touched.
3. **Given** the limiter reports success, **When** a request arrives, **Then** the endpoint behaves exactly as today.

---

### User Story 2 - Legitimate flows never hit the limits (Priority: P2)

As a user clicking my verification email once, or a dashboard polling
public stats at a sane interval, I never see a `429`.

**Why this priority**: Rate limits that catch real traffic are a regression;
the limits were sized so real flows sit far below them.

**Independent Test**: One verify click per link and stats polling at the
cache's own 5-minute granularity stay well under 5/60 s and 30/60 s
respectively; the full existing test corpus passes unmodified (bindings are
absent in the test pool, where the middleware fails open by design).

**Acceptance Scenarios**:

1. **Given** an instance without the new bindings configured, **When** either endpoint is used, **Then** behavior is unchanged (fail-open with a single operator warning — the existing pattern).
2. **Given** normal usage volumes, **When** the bindings are configured at the documented limits, **Then** legitimate flows complete without ever seeing `429`.

---

### User Story 3 - The disabled-stats gate stays first (Priority: P3)

As an operator who disabled public stats (#156), I want a disabled instance
to keep answering a uniform `404` — never a `429` that reveals the endpoint
exists and is rate-limited.

**Why this priority**: #156's design goal is that probing reveals nothing;
the limiter must not create a new observable.

**Independent Test**: With `PUBLIC_STATS="false"` and the limiter forced to
"exceeded", requests still receive `404` (the gate short-circuits before the
limiter) and consume no rate-limit budget.

**Acceptance Scenarios**:

1. **Given** `PUBLIC_STATS="false"`, **When** any volume of requests arrives, **Then** every response is the #156 `404` and the limiter is never consulted.

---

### Edge Cases

- **Binding not configured** (fresh deployments, test pool): fail open with
  one warning per isolate — identical to the OAuth limiters; operators who
  skip the wrangler.toml blocks lose damping but nothing breaks.
- **Shared office/CGNAT networks**: keying is per truncated client network
  (/24 IPv4, /48 IPv6), so a large NAT could aggregate users; the stats
  limit (30/60 s) absorbs this; the verify limit matches the OAuth callback
  limit that already governs the same user journey.
- **Per-location scoping**: limits apply per edge location per key
  (documented platform behavior) — a distributed attacker gets the limit at
  each location, which still bounds total throughput per location and is the
  accepted platform semantic (same as 058).
- **Rate-limited verify clicks**: a real user re-clicking an email link
  more than 5 times in a minute briefly sees `429` with `Retry-After: 60`;
  the token remains valid — no data loss, retry succeeds.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `GET /api/v1/auth/link/verify/{token}` MUST be rate-limited at 5 requests per 60 seconds per truncated client network, evaluated before any token processing or database access.
- **FR-002**: `GET /api/v1/stats/{range}` MUST be rate-limited at 30 requests per 60 seconds per truncated client network, evaluated before range validation, cache access, and database access — but **after** the `PUBLIC_STATS` disabled gate (#156), which MUST keep returning `404` without consuming limiter budget.
- **FR-003**: Limited requests MUST receive the standard `429` error body with a `Retry-After` header, identical in shape to the existing OAuth limiter responses.
- **FR-004**: When a binding is not configured, the endpoint MUST fail open with the existing one-warning-per-isolate behavior; no other behavior may change.
- **FR-005**: Both operations MUST document the `429` response in the API contract (reusing the existing shared `TooManyRequests` response).
- **FR-006**: The two new limiter namespaces MUST NOT collide with existing ones (account-unique namespace identifiers, continuing from the OAuth pair).
- **FR-007**: Operator documentation MUST cover the new configuration blocks and record why a blanket unauthenticated-401 limiter is deferred to zone-level tooling.

### Key Entities

No persisted data. Two new edge rate-limiter namespaces (configuration-only).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With bindings configured, anonymous request floods against either endpoint are capped at the documented per-network rates; database work per network is bounded at ≤5 verify lookups and ≤30 stats reads per minute per location.
- **SC-002**: Zero behavior change when bindings are absent; the full pre-existing test corpus passes unmodified.
- **SC-003**: Legitimate flows (one verify click; dashboard polling at or above the cache's 5-minute granularity) never observe `429` at the documented limits.
- **SC-004**: A disabled-stats instance never emits `429` from this feature (the #156 `404` remains the uniform response).

## Assumptions

- The truncated-IP keying from `specs/058-oauth-rate-limiting/` remains the
  right key for unauthenticated endpoints (nothing better exists before
  auth); its known NAT-aggregation tradeoff is accepted and documented.
- The platform's approximate, per-location semantics are sufficient: the
  goal is abuse damping, not exact quotas (matches 058's accepted semantics).
- Limits are operator-tunable by editing the configuration blocks; the
  documented values are defaults, not contract.
- The deferred 401-path limiter remains tracked by this issue's research
  notes and operator docs rather than a code path; zone-level WAF rules are
  the recommended tool for broad-spectrum throttling.
