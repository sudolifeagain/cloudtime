# Acceptance Checklist: Optional Google Hosted Domain Restriction

This checklist enforces the gate between PR1 (spec) and PR2 (implementation), and the gate between PR2 and production deployment.

## PR1 (Spec) gate — must be ✅ before merging

- [ ] `spec.md` covers FR-001 through FR-008 with no `[NEEDS CLARIFICATION]` markers.
- [ ] `plan.md` Constitution Check has all five principles marked PASS.
- [ ] `research.md` documents the `hd`-vs-query-param distinction, case sensitivity, and fail-closed default.
- [ ] `tasks.md` separates PR1 from PR2 tasks and lists dependencies.
- [ ] `contracts/openapi-diff.md` shows additive changes (new `Forbidden.yaml`, `403` reference on the callback path, one description line on the initiate path).
- [ ] `schemas/components/responses/Forbidden.yaml` exists and follows the shape of `Unauthorized.yaml` / `BadRequest.yaml`.
- [ ] `schemas/paths/auth/provider-callback.yaml` references `Forbidden.yaml` under `'403'`.
- [ ] `schemas/paths/auth/provider.yaml` description mentions `GOOGLE_HOSTED_DOMAIN`.
- [ ] `npm run generate` runs cleanly. `git diff src/types/generated.ts` shows only additive changes (new 403 response type and operation entry).
- [ ] PR1 contains no changes under `src/utils/oauth.ts`, `src/routes/auth/`, `src/types.ts`, or `wrangler.toml` beyond doc comments.

## PR2 (Implementation) gate — must be ✅ before merging

### Code
- [ ] `src/types.ts` declares `GOOGLE_HOSTED_DOMAIN?: string` on `Env`.
- [ ] `src/utils/oauth.ts` Google branch of `buildAuthorizeUrl` sets `hd=<env value>` only when the env var is truthy.
- [ ] `src/utils/oauth.ts` exports `HostedDomainError` and throws it from `validateGoogleIdToken` after all other claim validations.
- [ ] `src/routes/auth/login.ts` callback catch block returns 403 with `{"error": "Account domain not allowed"}` and `noCacheHeaders()` on `HostedDomainError`.
- [ ] `wrangler.toml` documents the optional `GOOGLE_HOSTED_DOMAIN` variable as a comment.
- [ ] `npx tsc --noEmit` passes with zero errors.
- [ ] Diff for GitHub and Discord paths is empty (no accidental cross-provider impact).

### Behavior (per `quickstart.md`)
- [ ] Scenario A: matching-domain user logs in successfully.
- [ ] Scenario B: personal Gmail user receives 403; no DB row created.
- [ ] Scenario C: different Workspace domain receives 403 with `reason=hd-mismatch`.
- [ ] Scenario D: env var unset ⇒ byte-identical to pre-feature behavior.
- [ ] Scenario E: mixed-case `GOOGLE_HOSTED_DOMAIN` value matches a lowercase `hd` claim.

### Documentation
- [ ] PR2 description references Issue #37, links back to PR1, and includes scenario results.

## Post-deployment gate

- [ ] First 24h after enabling `GOOGLE_HOSTED_DOMAIN`: monitor `wrangler tail` for unexpected `hd-mismatch` or `hd-missing` warnings (expected only for non-org accounts).
- [ ] First 7d: zero support reports of legitimate org users blocked.
- [ ] Operator runbook captures the "adding env var locks out non-org users" behavior.
