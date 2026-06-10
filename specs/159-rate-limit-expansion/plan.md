# Implementation Plan: Rate limiting beyond the OAuth endpoints

**Branch**: `159-rate-limit-expansion` | **Date**: 2026-06-10 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/159-rate-limit-expansion/spec.md`

## Summary

Extend the 058 rate-limiting pattern to the two remaining unauthenticated D1-touching endpoints: `GET /auth/link/verify/{token}` (5/60 s, namespace 1003) and `GET /stats/{range}` (30/60 s, namespace 1004), both keyed by the existing truncated-IP scheme and failing open with one warning when unbound. The `PUBLIC_STATS` disabled gate (#156) stays ahead of the stats limiter (404 always, never 429, zero budget spent). The issue's optional unauthenticated-401 limiter is deferred to zone-level WAF with recorded rationale (research D-4). Closes Issue #159.

**PR1 (this PR)**: SpecKit artifacts + `429` (`$ref` shared `TooManyRequests`) on the two operations + regenerated types. **No bindings, wiring, or behavior changes.**

**PR2 (after PR1 merges)**: two `[[ratelimits]]` blocks in `wrangler.toml`; `RATE_LIMIT_LINK_VERIFY`/`RATE_LIMIT_PUBLIC_STATS` on `Env`; `rateLimitMiddleware` wiring on the verify route and inside `getGlobalStats` after the #156 gate; integration tests with stubbed bindings; `docs/cloudflare-constraints.md` note on the deferred 401 limiter.

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers)
**Primary Dependencies**: Hono >= 4.9.7; Workers Rate Limiting binding (GA since 2025-09; `[[ratelimits]]` syntax current; `period` ∈ {10, 60}; namespace ids account-unique; per-colo approximate counting)
**Storage**: none — configuration + middleware only.
**Testing**: Vitest + workers pool. Bindings are absent in the test pool, so the default suite exercises fail-open (zero change). Binding-present behavior is tested by passing a stub `{ limit: async () => ({ success: false }) }` (and a success stub) via env overrides — the same per-request override pattern used across the integration suite. `tests/security/rate-limit.test.ts` already unit-tests the keying.
**Performance Goals**: <10ms CPU — one binding call per limited request; rejected requests do strictly less work than today.
**Constraints**: gate ordering on stats (`PUBLIC_STATS` 404 gate → limiter → handler, FR-002/SC-004); verify limiter runs before token work but after the 405 method check (a 405 probe is static and free; spending limiter budget on it would let method probes exhaust the budget of a user's real click — research D-2); fail-open semantics unchanged (FR-004).

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | `429` documented on both operations first (PR1, additive, shared component); bindings/wiring follow (PR2). |
| II. Cloudflare-Native | PASS | Uses the platform's GA rate-limiting binding exactly as 058 does; rejected requests cost no D1/KV. Per-colo approximation accepted and documented. |
| III. Type Safety | PASS | `Env` additions live in the manual bindings file (PR2); generated types regenerated for the response-map changes. |
| IV. Legal/Trademark | PASS | Platform feature; no third-party behavior consulted beyond Cloudflare's own docs. |
| V. Simplicity First | PASS | Reuses `rateLimitMiddleware` unchanged; two bindings, two wiring points, no new abstractions. The 401-limiter is deferred rather than half-built. |

## Project Structure

### Documentation (this feature)

```text
specs/159-rate-limit-expansion/
├── plan.md
├── spec.md
├── research.md
├── data-model.md
├── quickstart.md
├── tasks.md
├── contracts/
│   └── openapi-diff.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
# PR1
schemas/paths/auth/link-verify-token.yaml  # CHANGE: add '429' ($ref TooManyRequests) + description note
schemas/paths/meta/global-stats.yaml       # CHANGE: add '429' ($ref TooManyRequests) + description note
src/types/generated.ts                     # REGENERATED (429 entries on the two operations)

# PR2 (after PR1 merges)
wrangler.toml                              # CHANGE: [[ratelimits]] RATE_LIMIT_LINK_VERIFY (1003, 5/60) + RATE_LIMIT_PUBLIC_STATS (1004, 30/60)
src/types.ts                               # CHANGE: RATE_LIMIT_LINK_VERIFY?/RATE_LIMIT_PUBLIC_STATS?: RateLimit on Env
src/routes/auth/link.ts                    # CHANGE: limiter on the verify route after the 405 method check, before INSTANCE_MODE/token work
src/routes/meta.ts                         # CHANGE: limiter call inside getGlobalStats after the PUBLIC_STATS gate, before range validation
tests/env.d.ts                             # CHANGE: the two bindings on the test Env augmentation
tests/integration/pending-link-verify.test.ts  # CHANGE: stub-binding 429 case + fail-open case
tests/integration/global-stats.test.ts     # CHANGE: stub-binding 429 case; PUBLIC_STATS=false + exceeded limiter → still 404, limiter not consulted
docs/cloudflare-constraints.md             # CHANGE: rate-limit section — new namespaces + deferred-401-limiter rationale (zone WAF pointer)
```

**Structure Decision**: The verify route is a single `link.all(...)` handler, so its limiter cannot be route-level middleware without catching non-GET probes — instead the `rateLimitMiddleware` factory's inner check is invoked from within the handler right after the 405 branch (or the route is split GET/all — decided in PR2 for the smallest diff; the contract is only "before token work, after method check"). On stats, `getGlobalStats` already begins with the #156 gate; the limiter call follows it inline (the middleware factory is reusable as a plain function by invoking it with a no-op `next`, but the simplest correct form is hoisting the gate check into a tiny wrapper — PR2 picks the smaller diff while preserving FR-002 ordering, with the integration tests pinning the observable contract: disabled ⇒ 404 + zero budget; enabled+exceeded ⇒ 429 before cache/D1).

## Phases

- **PR1 — Spec + Design (this PR)**: author the SpecKit set; add `429` to the two operations; `npm run generate`; `npm run lint:api`; `npm run typecheck`.
- **PR2 — Implementation**: bindings + Env + wiring + tests + docs; `npm test` green; PR referencing #159 and PR1.

## Risks & Mitigations

- **Legitimate traffic catches a 429** → limits sized against real flows (one click per email; 5-min-cached stats), documented as operator-tunable defaults; `Retry-After: 60` keeps clients polite.
- **NAT aggregation (/24 keying)** → accepted 058 tradeoff, restated in docs; stats limit is 6× the verify limit for this reason.
- **Gate-ordering regression on stats (429 leaking from a disabled instance)** → integration test forces an always-exceeded stub with `PUBLIC_STATS="false"` and asserts 404 + limiter never called (spy stub).
- **Namespace collision** → 1003/1004 continue the account-unique sequence; documented in wrangler.toml beside the existing caveat comment.
- **Test pool has no real bindings** → by design: default suite = fail-open path; stub bindings cover both outcomes deterministically.
