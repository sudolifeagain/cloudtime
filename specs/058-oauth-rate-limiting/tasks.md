# Tasks: Rate Limiting for OAuth Endpoints

**Branch**: `058-oauth-rate-limiting`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Generated**: 2026-05-17

These tasks cover both PRs of the SpecKit 2-PR workflow. PR1 contains specs/schemas only (no implementation). PR2 contains middleware wiring, binding registration, and verification.

## PR1 — Spec + Design

- [x] **T-001**: Author `specs/058-oauth-rate-limiting/spec.md` covering FR-001 through FR-010, NFRs, and success criteria.
- [x] **T-002**: Author `plan.md` with Constitution Check, structure, and phase outputs.
- [x] **T-003**: Author `research.md` documenting binding choice, IP truncation, fail-open behavior.
- [x] **T-004**: Author `quickstart.md` with scenarios A–E for manual verification.
- [x] **T-005**: Author `contracts/openapi-diff.md` summarizing description-only changes.
- [x] **T-006**: Author `checklists/requirements.md` (acceptance gate).
- [x] **T-007**: Update `schemas/components/responses/TooManyRequests.yaml` to generic endpoint-dependent language so non-OAuth endpoints do not inherit OAuth-specific thresholds.
- [x] **T-008**: Add endpoint-specific rate-limit language in `schemas/paths/auth/provider.yaml` and `schemas/paths/auth/provider-callback.yaml` to state the enforced limits.
- [x] **T-009**: Run `npm run generate` to regenerate `src/types/generated.ts`. Verify the diff is description-only (no shape changes).
- [x] **T-010**: Commit PR1 (`spec:`/`docs:` prefix), push, open PR against `develop`.

## PR2 — Implementation (after PR1 merges)

### Binding registration

- [ ] **T-101**: Add two `[[ratelimits]]` entries to `wrangler.toml`:
  - `RATE_LIMIT_OAUTH_INITIATE` (`namespace_id = "1001"`, `[ratelimits.simple] limit = 10, period = 60`)
  - `RATE_LIMIT_OAUTH_CALLBACK` (`namespace_id = "1002"`, `[ratelimits.simple] limit = 5, period = 60`)
- [ ] **T-102**: Extend the `Env` type in `src/types.ts` to declare the two optional bindings (`?: RateLimit`). Use the `@cloudflare/workers-types` `RateLimit` type if exported; otherwise declare a minimal local interface matching `{ limit(opts: { key: string }): Promise<{ success: boolean }> }`.

### Middleware

- [ ] **T-103**: Create `src/middleware/rate-limit.ts` exporting `rateLimitMiddleware(getBinding, ruleName)`. Implementation:
  1. Extract `CF-Connecting-IP` (fall back to `X-Forwarded-For` first hop, then `"unknown"`).
  2. Truncate IPv4 to /24, IPv6 to /48.
  3. If binding is absent, log once per isolate and call `next()`.
  4. Otherwise, call `binding.limit({ key })`. On `success: false`, return 429 with `Retry-After: 60`, `Cache-Control: no-store`, `Pragma: no-cache`, body `{"error": "Too many requests"}`.
  5. On exceeded, emit a single warning log: `[rate-limit] rejected endpoint=<rule> key=<truncated>`.
- [ ] **T-104**: Add unit-style tests in middleware via `tsc --noEmit` + manual `wrangler dev`. No automated test infra exists yet in this repo, so verification is captured in quickstart.md.

### Route wiring

- [ ] **T-105**: In `src/routes/auth/login.ts`, import the middleware and mount it on both routes:
  ```ts
  login.get(
    "/:provider",
    rateLimitMiddleware((env) => env.RATE_LIMIT_OAUTH_INITIATE, "oauth-initiate"),
    handler,
  );
  login.get(
    "/:provider/callback",
    rateLimitMiddleware((env) => env.RATE_LIMIT_OAUTH_CALLBACK, "oauth-callback"),
    handler,
  );
  ```
- [ ] **T-106**: Verify the middleware runs before any KV/D1 access (place it before any provider validation logic in the chain).

### Verification

- [ ] **T-107**: Run `npx tsc --noEmit` — must pass with zero errors.
- [ ] **T-108**: Deploy to a staging environment, run all five scenarios in `quickstart.md`, attach results to the PR.
- [ ] **T-109**: Confirm `wrangler dev` (local, no remote bindings) prints the fail-open warning exactly once and serves requests normally.

### Documentation

- [ ] **T-110**: Update `docs/cloudflare-constraints.md` to mention the new rate-limiter bindings and instruct operators to verify current Cloudflare plan limits before production deployment.

### PR2 submission

- [ ] **T-111**: Commit with `fix:` prefix (security fix). Push branch, open PR against `develop` referencing this spec.

## Dependencies

```
T-001 … T-009 → T-010 (PR1 merge)
T-010 → T-101 … T-111 (PR2 work cannot start until PR1 is merged)
T-103 → T-105 (middleware must exist before mounting)
T-101 → T-105 (binding must be declared before mounting)
T-105 → T-107 → T-108 (compile then verify)
```

## Out of scope (do not implement in this feature)

- Authenticated route rate limits (heartbeat ingestion, API key regeneration). Tracked as future work.
- Cloudflare WAF rules. Configured via dashboard, not code.
- Workers Analytics Engine integration for rate-limit metrics. Future enhancement.
