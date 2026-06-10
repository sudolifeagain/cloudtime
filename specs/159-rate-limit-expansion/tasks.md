# Tasks: Rate limiting beyond the OAuth endpoints

**Input**: Design documents from `specs/159-rate-limit-expansion/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/openapi-diff.md, quickstart.md

**Organization**: Phase 1 is PR1 (this branch — contract only; submit after #158 PR1 merges and rebase, to avoid SpecKit-pointer conflicts); Phases 2+ are PR2 (after PR1 merges). Tests included per the spec's Independent Test criteria.

## Phase 1: Setup — PR1, contract only (this branch)

- [ ] T001 Apply `specs/159-rate-limit-expansion/contracts/openapi-diff.md`: add `'429': $ref ../../components/responses/TooManyRequests.yaml` plus the description sentence to `schemas/paths/auth/link-verify-token.yaml` and `schemas/paths/meta/global-stats.yaml`. Run `npm run lint:api`. Commit the spec change on its own (SpecKit artifacts committed first).
- [ ] T002 Run `npm run generate`; verify the `src/types/generated.ts` diff is exactly the two additive 429 entries + JSDoc. Commit separately.
- [ ] T003 Rebase onto `develop` (after #158 PR1 merges, resolving the `.specify/feature.json` / `CLAUDE.md` pointer to 159), run `npm run typecheck`, push `159-rate-limit-expansion`, open PR1 targeting `develop` referencing Issue #159.

**Checkpoint**: PR1 merged. Phases below on a fresh branch off `develop`.

## Phase 2: Foundational — PR2 prerequisites

- [ ] T004 [P] Add the two `[[ratelimits]]` blocks to `wrangler.toml` (RATE_LIMIT_LINK_VERIFY ns "1003" limit 5 period 60; RATE_LIMIT_PUBLIC_STATS ns "1004" limit 30 period 60) below the existing pair, keeping the plan-limits caveat comment. CRITICAL: commit with the D1/KV placeholder ids intact.
- [ ] T005 [P] Add `RATE_LIMIT_LINK_VERIFY?: RateLimit` and `RATE_LIMIT_PUBLIC_STATS?: RateLimit` to `Env` in `src/types.ts`, and to the test augmentation in `tests/env.d.ts`.

## Phase 3: User Story 1 — Floods damped (P1) 🎯 MVP

**Goal**: Exceeded limiters yield 429 before any token/cache/D1 work.

- [ ] T006 [US1] Wire the verify limiter in `src/routes/auth/link.ts`: inside the `all("/link/verify/:token")` handler, after the 405 method branch and before the `INSTANCE_MODE` check, consult `c.env.RATE_LIMIT_LINK_VERIFY` with the truncated-IP key (reuse the keying/fail-open/429 shape of `src/middleware/rate-limit.ts` — extract a callable helper from the middleware factory if needed so the single-`all()` route can use it inline; keep one warning per isolate on missing binding) (research D-2).
- [ ] T007 [US1] Wire the stats limiter in `src/routes/meta.ts` `getGlobalStats`: after the `PUBLIC_STATS` disabled gate, before range validation/KV/D1, same helper, binding `RATE_LIMIT_PUBLIC_STATS` (research D-3).
- [ ] T008 [US1] Integration tests with stub bindings via env overrides: `tests/integration/pending-link-verify.test.ts` — always-exceeded stub → 429 + `Retry-After: 60` and the seeded token is NOT consumed; `tests/integration/global-stats.test.ts` — always-exceeded stub → 429 and no KV write.

## Phase 4: User Story 2 — Legitimate flows unaffected (P2)

- [ ] T009 [P] [US2] Add pass-through cases: success-returning stub → endpoints behave exactly as today (verify consumes token / stats 200 + cache write); absent binding (default pool) → existing cases pass unmodified, fail-open warning path covered.

## Phase 5: User Story 3 — Disabled stats stay 404 (P3)

- [ ] T010 [P] [US3] Add to `tests/integration/global-stats.test.ts`: `PUBLIC_STATS="false"` + call-recording always-exceeded stub → response 404 and the stub was never invoked (SC-004, research D-3).

## Phase 6: Polish & Cross-Cutting

- [ ] T011 [P] Update `docs/cloudflare-constraints.md`: document the four limiter namespaces and record the deferred unauthenticated-401 limiter decision with the zone-level WAF recommendation (FR-007, research D-4).
- [ ] T012 Run `npm run typecheck && npm test`; open PR2 targeting `develop` referencing Issue #159 and PR1. PR body notes operator action (new wrangler.toml blocks) for release notes.

## Dependencies

- T001 → T002 → T003; PR1 merge gates the rest
- T004/T005 parallel; both block T006/T007
- T006 blocks the verify half of T008; T007 blocks the stats half and T010
- T009/T010/T011 parallel after T006+T007; T012 last

## Parallel Example

```text
Wave 1: T004 wrangler.toml | T005 Env types
Wave 2: T006 verify wiring | T007 stats wiring | T011 docs
Wave 3: T008 429 cases | T009 pass-through | T010 disabled-gate spy → T012
```

## Implementation Strategy

MVP = Phase 3 (US1). US2 is regression assurance, US3 pins the #156 interaction. One small PR2; the only operator-visible artifact is the two wrangler.toml blocks (release-notes callout in T012).
