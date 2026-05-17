# Research: Rate Limiting for OAuth Endpoints

## Decision 1: Use Cloudflare Workers Rate Limiting binding (native), not custom KV counters

**Decision**: Bind the Workers Rate Limiting API via `[[unsafe.bindings]]` in `wrangler.toml`.

**Rationale**:
- The Rate Limiting binding lives in Cloudflare's edge data plane. It performs the counter increment + check inline with the request, without consuming Worker CPU for the storage round-trip. Latency is single-digit milliseconds at the edge.
- Custom KV-based counters cost two KV operations per request (one read, one write), each counted against the free-tier 1,000/day write budget — defeating the original goal of protecting the KV write budget from abuse.
- D1-backed counters would block the request on a SQL round-trip and conflict with the 10ms CPU budget on Workers free tier.
- The `TooManyRequests.yaml` component already specifies "Implementation: Use Cloudflare Workers native Rate Limiting binding." — the Constitution-style direction is set.

**Alternatives considered**:
1. **KV INCR pattern**: rejected — counts against the KV write budget that we are trying to protect.
2. **Durable Objects counter**: rejected — adds a paid-only dependency for a problem the native binding solves.
3. **In-memory per-isolate counter**: rejected — Workers isolates are not stable; cardinality is unbounded across cold starts.

---

## Decision 2: `[[unsafe.bindings]]` syntax with `simple` rule type

**Decision**: Use the `[[unsafe.bindings]]` table with `type = "ratelimit"` and a `simple` rule configuration.

**Rationale**:
- As of compatibility_date 2025-03-09 (the current pin in `wrangler.toml`), the Rate Limiting binding is exposed under `unsafe.bindings`. Cloudflare uses the `unsafe` prefix for bindings that are stable in production but whose configuration shape may still evolve.
- The `simple` rule provides a fixed window with `limit` (requests) and `period` (seconds). This matches FR-001/FR-002 (10/60 and 5/60).
- `namespace_id` must be a unique integer per binding within the account. We pick `1001` (initiate) and `1002` (callback) to leave room for future bindings.

**Alternatives considered**:
1. **Single binding with composite key**: rejected — Cloudflare's rate-limit API is keyed inside the binding, so two separate bindings give cleaner observability and let us tune limits independently without redeploying both.
2. **Wait for a stable (non-`unsafe`) binding name**: rejected — would block the feature for an unbounded time; the API surface is documented and stable for production use.

---

## Decision 3: IP key derivation and truncation

**Decision**: Use `CF-Connecting-IP` (Cloudflare's edge-set header), truncating IPv4 to /24 and IPv6 to /48.

**Rationale**:
- `CF-Connecting-IP` is the canonical source for the client IP behind Cloudflare. It is set by the edge and cannot be forged by clients.
- IPv4 /24 truncation (e.g., `203.0.113.42` → `203.0.113.0`) prevents trivial single-IP bypass while accommodating shared NAT environments at ISP scale.
- IPv6 /48 is the IETF-recommended customer-prefix size (RFC 6177). Truncating to /48 prevents an attacker on a /48 allocation from cycling individual /128 addresses to defeat the limit.
- Truncated keys also keep log cardinality manageable.

**Fallback**: If `CF-Connecting-IP` is absent (e.g., local `wrangler dev`), fall back to `X-Forwarded-For` (first hop) and finally to a constant `"unknown"` key. In the constant-fallback case, the limiter effectively becomes a global rate limit — acceptable for dev, surfaced via the fail-open log.

**Alternatives considered**:
1. **Full IP as key**: rejected — too easy to bypass with IPv6 prefix rotation; high log cardinality.
2. **Hash the IP**: rejected — defeats prefix-based aggregation and complicates debugging.

---

## Decision 4: Fail-open when binding is undefined

**Decision**: If the rate-limit binding is missing at runtime (e.g., `RATE_LIMIT_OAUTH_INITIATE` is `undefined` because the dev environment has no `unsafe.bindings` configured), the middleware allows the request and emits a single warning log on first occurrence.

**Rationale**:
- Local development should not require Cloudflare account setup. Fail-closed (returning 500/503 when the binding is missing) would force every contributor to configure rate-limit bindings just to run `wrangler dev`.
- A startup warning is sufficient to alert operators that production deployment is incomplete; the warning is rate-limited to once per isolate to avoid log spam.
- This is consistent with the existing `noCacheHeaders()` pattern in this codebase — defensive but unobtrusive.

**Alternatives considered**:
1. **Fail-closed**: rejected — operationally hostile for development.
2. **Soft-warn on every request**: rejected — log spam in dev.

---

## Decision 5: 429 response shape

**Decision**: `429 Too Many Requests` with `Retry-After: <seconds>`, `Cache-Control: no-store`, `Pragma: no-cache`, JSON body `{"error": "Too many requests"}`.

**Rationale**:
- Matches the existing `TooManyRequests.yaml` response component.
- Aligns with `Retry-After` semantics in RFC 7231 §7.1.3 (integer seconds).
- `Cache-Control: no-store` prevents intermediate caches (browser bfcache, Cloudflare cache) from serving cached 429s past the window.

**Retry-After value**: For a fixed window of 60 seconds, the binding does not expose remaining-window seconds directly. We return a conservative `Retry-After: 60` — overestimating is safer than underestimating (clients won't retry too early).

**Alternatives considered**:
1. **Returning remaining-window seconds**: rejected — the `simple` rule type does not expose this. Could be added later if Cloudflare exposes it.

---

## Decision 6: Middleware mounts at the route level (not global)

**Decision**: Apply the rate-limit middleware to `GET /auth/:provider` and `GET /auth/:provider/callback` only, not globally in `src/index.ts`.

**Rationale**:
- Heartbeat ingestion (`POST /heartbeats`) is authenticated by API key and protected by separate flow controls; rate-limiting it at the edge would risk blocking legitimate batch ingestion from editor plugins.
- Mounting at the route level keeps the dependency on the binding scoped to OAuth code, simplifying tests and future removal/rotation.

**Alternatives considered**:
1. **Global rate-limit on all `/auth/*`**: rejected — `/auth/session`, `/auth/api-key`, etc. are authenticated and have different threat models.
2. **Global rate-limit on the entire Worker**: rejected — would interfere with heartbeat batches.

---

## Decision 7: OpenAPI schema change is description-only

**Decision**: Tighten the `description` on the `429` block in `provider.yaml` and `provider-callback.yaml` from "Recommended" to "Enforced", and tighten the description on `TooManyRequests.yaml` to match the implemented values.

**Rationale**:
- The 429 response and `Retry-After` header are already declared in the schema; the implementation makes the documented behavior real.
- No new response codes, no new headers, no new schemas. `npm run generate` produces a no-op or near-no-op for `src/types/generated.ts`.
- Keeping the OpenAPI change description-only respects the SDD principle that schema changes precede implementation, while not introducing real type churn.
