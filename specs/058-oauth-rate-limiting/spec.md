# Feature Specification: Rate Limiting for OAuth Endpoints

**Feature Branch**: `058-oauth-rate-limiting`
**Created**: 2026-05-17
**Status**: Draft
**Input**: GitHub Issue #58 — Add rate limiting to OAuth endpoints (security label)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Protect OAuth initiate from KV exhaustion floods (Priority: P1)

As an operator of a CloudTime instance, I want the OAuth initiate endpoint (`GET /auth/:provider`) to reject abusive request rates from a single IP, so that an attacker cannot exhaust the KV namespace by flooding `oauth:state:*` entries (each with a 10-minute TTL).

Today, an unauthenticated attacker can hit `GET /auth/github` in a tight loop and generate one KV write per request, plus a Set-Cookie header. The free-tier KV write budget (1,000/day) can be exhausted in seconds, and the attack also wastes CPU on PKCE / state generation per call.

**Why this priority**: This is the primary attack vector documented in Issue #58 — direct denial of service against shared infrastructure (KV write budget). The mitigation must land first because all other OAuth-related abuse scenarios depend on the initiate endpoint being accessible.

**Independent Test**: Send 100 `GET /auth/github` requests from a single IP within one minute. Verify that requests after the 10th return `HTTP 429` with a `Retry-After` header, and that no further `oauth:state:*` KV entries are created until the limit window resets.

**Acceptance Scenarios**:

1. **Given** a fresh client IP, **When** it issues ≤10 `GET /auth/:provider` requests within a 60-second sliding window, **Then** each request returns `302` and creates exactly one `oauth:state:*` KV entry.
2. **Given** a client IP that has issued 10 successful requests in the last 60 seconds, **When** the 11th request arrives, **Then** the server returns `429 Too Many Requests` with a `Retry-After` header indicating seconds until the window resets, and no KV write occurs.
3. **Given** an IP previously rate-limited, **When** the 60-second window has fully elapsed, **Then** subsequent requests resume normally and increment a fresh counter.
4. **Given** a request from an IP behind a Cloudflare-fronted CDN, **When** rate limiting evaluates the source, **Then** the originating client IP is used (via `CF-Connecting-IP`), not an intermediate proxy.

---

### User Story 2 - Protect OAuth callback from invalid-state CPU floods (Priority: P1)

As an operator, I want `GET /auth/:provider/callback` to reject excessive request rates from a single IP, so that an attacker cannot waste CPU on cryptographic state validation and provider token-exchange attempts that will inevitably fail.

The callback endpoint performs a constant-time state comparison, a KV lookup, and (if state validates) a remote HTTPS call to the provider's token endpoint. Mass invalid-state callbacks force the server to perform expensive constant-time checks; mass valid-state callbacks (e.g., from a compromised authorization flow) force the server to make provider API calls that count against the provider's per-app quota.

**Why this priority**: The callback endpoint is more expensive per request than the initiate endpoint (multiple network round-trips on the happy path). Rate limiting here protects both the Workers CPU budget and the upstream provider's rate limits.

**Independent Test**: Send 30 `GET /auth/github/callback?state=invalid&code=invalid` requests from a single IP within one minute. Verify that requests after the 5th return `429`, and that no token-exchange HTTPS call is made on the rate-limited requests.

**Acceptance Scenarios**:

1. **Given** a fresh client IP, **When** it issues ≤5 `GET /auth/:provider/callback` requests within a 60-second sliding window, **Then** each request is processed (state validation runs, success or error returned).
2. **Given** a client IP that has issued 5 callback requests in the last 60 seconds, **When** the 6th request arrives, **Then** the server returns `429 Too Many Requests` with a `Retry-After` header before performing state validation or provider API calls.
3. **Given** a legitimate user who happens to retry the OAuth flow after a network hiccup, **When** their retry count stays within 5/min, **Then** the retry succeeds without being rate-limited.

---

### User Story 3 - Observability when rate limits engage (Priority: P2)

As an operator, I want a structured log entry whenever a request is rejected by rate limiting, so that I can detect abuse patterns and tune thresholds.

**Why this priority**: Without logs, operators cannot distinguish between legitimate traffic spikes and active abuse, and cannot decide whether to widen or narrow the limits.

**Independent Test**: Trigger a 429 response and verify a single line is emitted to `console.warn` (or equivalent) containing the IP (hashed or truncated), endpoint, and limit name. The log MUST NOT contain the full state, code, or session cookie values.

**Acceptance Scenarios**:

1. **Given** a request is rejected by the OAuth initiate limiter, **When** the 429 is returned, **Then** exactly one warning log is emitted containing the endpoint identifier, the rate-limit key (IP, truncated to /24 for IPv4 or /48 for IPv6 to limit cardinality), and the rule name.
2. **Given** a 429 response, **When** the log line is captured, **Then** it contains no PII beyond the truncated IP, no OAuth state, no code parameter, and no cookie values.

---

### Edge Cases

- **Multi-instance deployments**: A user behind a corporate NAT may share an IP with many colleagues. The 10/min initiate limit must be generous enough that simultaneous logins from one NAT do not collide. The recommendation in `TooManyRequests.yaml` (10/min) is acceptable for this scenario.
- **Legitimate retry storms**: A user with a flaky network may retry login 3-5 times in quick succession. The 5/min callback limit accommodates this. Tighter limits would block legitimate users.
- **Bot/scanner traffic**: Cloudflare's bot protection runs upstream of Workers. Rate limiting in the Worker is a second layer for non-bot abusive traffic (e.g., scripted attacks from data-center IPs that Cloudflare's bot scoring may not catch).
- **Free-tier rate-limiter quota**: Cloudflare Workers free plan includes 1,000 requests/day for the rate limiter binding. A self-hosted single-user instance is unlikely to exceed this; commercial deployments may need the paid plan.
- **IPv6 client identification**: For IPv6 clients, the rate-limit key must use the /48 prefix (the standard assigned-to-customer block size) rather than the full 128-bit address, to prevent attackers from cycling through cheap /128 addresses inside a /48.
- **Failed rate-limiter binding (graceful degradation)**: If the rate-limiter binding is unconfigured (e.g., local development), the middleware MUST fail-open (allow the request) rather than 500. A warning log is emitted on the first request only.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST apply a rate limit to `GET /auth/:provider` of 10 requests per 60-second sliding window, keyed by client IP (using `CF-Connecting-IP`, falling back to `Request.cf.colo` + remote address if absent).
- **FR-002**: The system MUST apply a rate limit to `GET /auth/:provider/callback` of 5 requests per 60-second sliding window, keyed by client IP using the same key derivation as FR-001.
- **FR-003**: When a rate limit is exceeded, the system MUST respond with HTTP `429 Too Many Requests`, a `Retry-After` header (seconds, integer), `Cache-Control: no-store`, `Pragma: no-cache`, and a JSON body `{"error": "Too many requests"}`.
- **FR-004**: When a rate limit is exceeded, the system MUST NOT perform any KV write, D1 query, or provider HTTPS call associated with the rejected request.
- **FR-005**: The rate-limiter check MUST run before CSRF middleware and before route handler logic, so that the cost of rejected requests stays under 1ms CPU.
- **FR-006**: IPv4 keys MUST be truncated to /24, and IPv6 keys MUST be truncated to /48, when stored in the rate-limit counter and when emitted in logs.
- **FR-007**: When a rate limit is exceeded, the system MUST emit exactly one structured warning log per rejected request, containing: timestamp, endpoint identifier, rule name, and truncated IP. The log MUST NOT contain OAuth state, code, cookie values, or user-identifiable data beyond the truncated IP.
- **FR-008**: The rate-limiter binding MUST be optional in development. If the binding is not configured at startup, the middleware MUST fail-open (allow the request) and emit a single warning log on the first request only.
- **FR-009**: The OpenAPI schema for both endpoints MUST advertise the `429` response (already present in the schema; this feature ensures the documented behavior is actually enforced).
- **FR-010**: The rate limit MUST NOT apply to authenticated routes (`/heartbeats`, `/users/current`, etc.) — those are protected by API key auth and have their own access control. This feature scopes only to public OAuth endpoints.

### Non-Functional Requirements

- **NFR-001**: Rate-limit check overhead MUST be under 1ms of Workers CPU time per request.
- **NFR-002**: The implementation MUST use Cloudflare Workers' native Rate Limiting binding (no custom KV-based counter), per `TooManyRequests.yaml`.
- **NFR-003**: Configuration values (window size, request budget) MUST live in `wrangler.toml` rather than source code, so that operators can adjust limits without redeploying the Worker logic.

### Key Entities *(no database changes)*

No new database tables or columns. The rate-limiter state is held entirely in Cloudflare's edge data plane via the binding.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: At a request rate of 100 OAuth initiate calls/minute from a single IP, no more than 10 succeed; the remaining 90 return 429 with a `Retry-After` header.
- **SC-002**: At a sustained 100 callback calls/minute from a single IP, no more than 5 reach state validation; the rest are rejected before KV access.
- **SC-003**: Median CPU time per rejected request is under 1ms (measured via `Date.now()` deltas around the middleware).
- **SC-004**: After enabling the feature, KV daily write counts on the production instance stay within 50% of the free-tier budget (500 writes/day) under normal usage — confirming that abuse vectors are no longer reaching the KV write path.
- **SC-005**: Zero false-positive 429s reported by legitimate users during the first 30 days of deployment (measured via support reports or Cloudflare analytics).

## Out of Scope

- **Authenticated route rate limiting** (heartbeat ingestion, API key regeneration). These are independent concerns and will be tracked separately if needed.
- **Per-user rate limits on PendingLink/account-linking flows**. The application-level limit (3 active pending links per user) already exists in `src/routes/auth/login.ts`. Adding edge rate limits there is optional and not blocking #58.
- **Cloudflare WAF rules**. WAF is configured via the Cloudflare dashboard and is out of scope for a code change. Operators may choose to add complementary WAF rules.
- **Rate limit dashboards/alerting**. Visibility beyond log warnings (e.g., Workers Analytics Engine queries) is a follow-up.
