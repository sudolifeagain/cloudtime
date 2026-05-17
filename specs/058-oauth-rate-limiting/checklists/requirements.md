# Acceptance Checklist: Rate Limiting for OAuth Endpoints

This checklist enforces the gate between PR1 (spec) and PR2 (implementation), and the gate between PR2 and production deployment.

## PR1 (Spec) gate — must be ✅ before merging

- [ ] `spec.md` lists FR-001 through FR-010 with no `[NEEDS CLARIFICATION]` markers.
- [ ] `plan.md` includes a Constitution Check table with all five principles marked PASS.
- [ ] `research.md` documents the binding choice, IP truncation, and fail-open behavior with rationale.
- [ ] `tasks.md` distinguishes PR1 from PR2 tasks and identifies dependencies.
- [ ] `contracts/openapi-diff.md` shows only description-level changes.
- [ ] `schemas/components/responses/TooManyRequests.yaml` remains generic, and `schemas/paths/auth/provider*.yaml` operation descriptions document the enforced OAuth values (10/60s, 5/60s).
- [ ] `npm run generate` runs cleanly. `git diff src/types/generated.ts` shows no type-shape changes (description/JSDoc-only diff is acceptable).
- [ ] PR1 contains no changes under `src/middleware/`, `src/routes/`, or `wrangler.toml`.
- [ ] PR1 description references Issue #58 and the SpecKit 2-PR workflow rule.

## PR2 (Implementation) gate — must be ✅ before merging

### Code
- [ ] `wrangler.toml` declares two `[[ratelimits]]` entries (`RATE_LIMIT_OAUTH_INITIATE`, `RATE_LIMIT_OAUTH_CALLBACK`) with the configured limits.
- [ ] `src/types.ts` exposes the bindings as optional fields on `Env`.
- [ ] `src/middleware/rate-limit.ts` implements `rateLimitMiddleware(getBinding, ruleName)` per `plan.md` § Design Outputs.
- [ ] Both OAuth routes in `src/routes/auth/login.ts` are wrapped by the middleware.
- [ ] `npx tsc --noEmit` passes with zero errors.
- [ ] The middleware runs before CSRF and before any KV/D1 access in the route handler.

### Behavior (per `quickstart.md`)
- [ ] Scenario A: 11th initiate request from one IP returns 429 with `Retry-After: 60`.
- [ ] Scenario B: 6th callback request from one IP returns 429 before state validation.
- [ ] Scenario C: Missing binding emits a single warning log and fails open in dev.
- [ ] Scenario D: IPv6 clients on a shared /48 share a counter; different /48s do not.
- [ ] Scenario E: 429 logs contain truncated IP only; no OAuth state, code, or cookie values appear in logs.

### Documentation
- [ ] `docs/cloudflare-constraints.md` mentions the new bindings and tells operators to verify current Cloudflare plan limits before production deployment.
- [ ] PR2 description links back to PR1, references Issue #58, and includes scenario results from `quickstart.md`.

## Post-deployment (production) gate

- [ ] First 24h post-deploy: monitor Worker logs for unexpected 429 spikes (legitimate-traffic false positives).
- [ ] First 7d post-deploy: monitor KV daily write counts — should stay flat or drop under previous baseline (success criterion SC-004).
- [ ] First 30d post-deploy: zero support reports of legitimate users blocked by rate limiting (SC-005).
- [ ] If false-positive 429s are observed: tune `simple = { limit, period }` in `wrangler.toml` and redeploy. No code change required.
