# Implementation Plan: Rate Limiting for OAuth Endpoints

**Branch**: `058-oauth-rate-limiting` | **Date**: 2026-05-17 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/058-oauth-rate-limiting/spec.md`

## Summary

Add Cloudflare Workers Rate Limiting bindings for `GET /auth/:provider` (10/min/IP) and `GET /auth/:provider/callback` (5/min/IP) to prevent KV exhaustion and CPU abuse. Wire a thin middleware that calls the binding before any handler logic, emits a 429 with `Retry-After` on limit exceeded, and fails-open when the binding is missing.

The OpenAPI schema already documents the 429 response via a shared component, so the schema changes are minimal: keep the shared `TooManyRequests` component generic and add endpoint-specific enforced limits to the two affected OAuth operation descriptions.

## Technical Context

**Language/Version**: TypeScript (ES2022 target, Cloudflare Workers runtime)
**Primary Dependencies**: Hono >= 4.9.7
**Storage**: D1 (no schema change), KV (no schema change)
**New binding**: Cloudflare Workers Rate Limiting (`[[ratelimits]]` in `wrangler.toml`)
**Testing**: Manual via `wrangler dev` + `tsc --noEmit`. End-to-end load test deferred to staging.
**Target Platform**: Cloudflare Workers (edge compute)
**Project Type**: Web service (REST API)
**Performance Goals**: <1ms CPU per rejected request; 10ms total per request remains the budget
**Constraints**: D1 batch / KV write limits unchanged; operators must verify current Cloudflare plan limits before production deployment

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | OpenAPI schema already advertises 429 on both paths; schema updates are description-only. `npm run generate` runs before implementation. |
| II. Cloudflare-Native | PASS | Uses native Rate Limiting binding (no custom KV counters). |
| III. Type Safety | PASS | Binding type comes from `@cloudflare/workers-types`. `AuthEnv` / `Env` extended via generated types where possible. |
| IV. Legal/Trademark | PASS | No WakaTime references. |
| V. Simplicity First | PASS | One new middleware (~40 lines), two `wrangler.toml` entries, no new abstractions. Falls back to a no-op when binding is absent. |

## Project Structure

### Documentation (this feature)

```text
specs/058-oauth-rate-limiting/
├── plan.md                # This file
├── spec.md                # Feature specification
├── research.md            # Phase 0 — rate-limiter binding research
├── quickstart.md          # Manual verification recipe
├── tasks.md               # Phase 2 output (/speckit-tasks)
├── contracts/
│   └── openapi-diff.md    # Description tightening for the two OAuth paths
└── checklists/
    └── requirements.md    # Acceptance checklist
```

### Source Code (repository root)

```text
src/
├── middleware/
│   └── rate-limit.ts      # NEW: rateLimitMiddleware(binding, ruleName)
├── routes/
│   └── auth/
│       └── login.ts       # Mount rateLimit on /:provider and /:provider/callback
└── types.ts               # Extend Env with RATE_LIMIT_OAUTH_INITIATE / RATE_LIMIT_OAUTH_CALLBACK bindings

wrangler.toml              # Add [[ratelimits]] entries for both limiters
schemas/paths/auth/
├── provider.yaml          # Description: enforced 10/min/IP
└── provider-callback.yaml # Description: enforced 5/min/IP
```

**Structure Decision**: Single-file middleware added under `src/middleware/`. Two binding entries under `[[ratelimits]]` in `wrangler.toml`. No new routes, no DB migration.

## Phase 0 — Research Outputs

See [research.md](./research.md). Key decisions:
1. Use `[[ratelimits]]` syntax (current Cloudflare Workers Rate Limiting binding configuration for Wrangler 4.36+).
2. Key derivation: `CF-Connecting-IP` → truncate to /24 (IPv4) or /48 (IPv6).
3. Fail-open on missing binding (development ergonomics > strict enforcement).

## Phase 1 — Design Outputs

### Middleware contract

```ts
// src/middleware/rate-limit.ts
export function rateLimitMiddleware(
  getBinding: (env: Env) => RateLimit | undefined,
  ruleName: string,
): MiddlewareHandler<{ Bindings: Env }>;
```

The middleware:
1. Reads `CF-Connecting-IP` (falling back to `c.req.header("X-Forwarded-For")` first hop for local dev).
2. Truncates the IP per FR-006.
3. Calls `binding.limit({ key })`. If `success: false`, returns 429 with `Retry-After`, `Cache-Control: no-store`, `Pragma: no-cache`.
4. If binding is undefined, logs once and calls `next()`.

### Binding config

```toml
# wrangler.toml — add to existing file
[[ratelimits]]
name = "RATE_LIMIT_OAUTH_INITIATE"
namespace_id = "1001"
  [ratelimits.simple]
  limit = 10
  period = 60

[[ratelimits]]
name = "RATE_LIMIT_OAUTH_CALLBACK"
namespace_id = "1002"
  [ratelimits.simple]
  limit = 5
  period = 60
```

### OpenAPI diff

See [contracts/openapi-diff.md](./contracts/openapi-diff.md). Both paths already declare 429; only description text changes. Endpoint-specific enforced limits live in the two OAuth operation descriptions, while the shared 429 response component remains generic for other endpoints that also reference it.

## Phase 2 — Implementation Tasks

See [tasks.md](./tasks.md) (generated by `/speckit-tasks`).

## Complexity Tracking

No constitution violations. No complexity justification needed.
