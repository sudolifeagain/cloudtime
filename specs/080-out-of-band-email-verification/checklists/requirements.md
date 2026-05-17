# Acceptance Checklist: Out-of-Band Email Verification for PendingLink

This checklist enforces the gates between PR1 / PR2 / production deployment.

## PR1 (Spec) gate — must be ✅ before merging

- [ ] `spec.md` covers FR-001..FR-012 and NFRs with no `[NEEDS CLARIFICATION]` markers.
- [ ] `plan.md` Constitution Check has all five principles marked PASS.
- [ ] `research.md` documents the 8 design decisions (provider, fail mode, token shape, GET semantics, TTL, response shape, selector explicitness, no-retry).
- [ ] `data-model.md` describes the two new columns and explicitly states "no backfill" with rationale.
- [ ] `tasks.md` separates PR1 from PR2 with dependency arrows.
- [ ] `contracts/openapi-diff.md` shows additive-only schema changes (new path, new 410 component, 403 added to existing approve path).
- [ ] `schemas/components/responses/Gone.yaml` exists and follows the shape of `Unauthorized.yaml` / `Forbidden.yaml`.
- [ ] `schemas/paths/auth/link-verify-token.yaml` declares 200 / 405 / 410.
- [ ] `schemas/paths/auth/link-approve.yaml` references `Forbidden.yaml` under `403`.
- [ ] `schemas/openapi.yaml` wires the new path.
- [ ] `migrations/0002_pending_link_email_verification.sql` exists, idempotent (`IF NOT EXISTS` on the index), backwards-compatible (columns are nullable).
- [ ] `src/db/schema.sql` is updated so fresh deployments via `npm run db:init` include the new columns.
- [ ] `npm run generate` runs cleanly. `git diff src/types/generated.ts` shows additive changes only.
- [ ] PR1 contains no changes under `src/utils/email/`, `src/routes/auth/login.ts`, `src/routes/auth/link.ts`, or `src/types.ts`.
- [ ] PR1 description references Issue #80 and the SpecKit 2-PR workflow.

## PR2 (Implementation) gate — must be ✅ before merging

### Code

- [ ] `src/types.ts` declares `EMAIL_PROVIDER?: string`, `EMAIL_FROM?: string`, `RESEND_API_KEY?: string` on `Env`.
- [ ] `src/utils/email/types.ts` exports `EmailMessage`, `EmailProvider`, `EmailNotConfiguredError`, `EmailSendError`.
- [ ] `src/utils/email/resend.ts` posts to `https://api.resend.com/emails` with bearer auth and a 2-second `AbortSignal.timeout(2000)`.
- [ ] `src/utils/email/index.ts` selects provider by `env.EMAIL_PROVIDER` and exposes a single `sendEmail(env, msg)` entry point.
- [ ] `src/routes/auth/login.ts` sends the email **before** the PendingLink INSERT. Failure path rolls back (no row written).
- [ ] `src/routes/auth/link.ts` has a new `GET /link/verify/:token` handler implemented via UPDATE-with-RETURNING.
- [ ] `src/routes/auth/link.ts` `POST /link/approve/:pending_link_id` returns 403 when `email_verified_at` is NULL.
- [ ] `src/utils/crypto.ts` exposes `generateVerificationToken()` returning `{plaintext, hash}`.
- [ ] `npx tsc --noEmit` passes with zero errors.
- [ ] `npm test` passes including new email and verify tests.
- [ ] No diff in `src/middleware/`, `src/utils/oauth.ts`, or any GitHub/Discord-specific code path.

### Behaviour (per `quickstart.md`)

- [ ] Scenario A: happy path produces 200 on approve after verification.
- [ ] Scenario B: approve without prior verification returns 403 with the documented body.
- [ ] Scenario C: token replay returns 410 Gone.
- [ ] Scenario D: expired token returns 410 Gone.
- [ ] Scenario E: invalid provider key rolls back the PendingLink and surfaces 502.
- [ ] Scenario F: missing `EMAIL_PROVIDER` surfaces 503 and emits a single warning per isolate.
- [ ] Scenario G: single-user mode behaviour is unchanged (no emails, verify endpoint always 410).
- [ ] Scenario H: non-GET methods return 405.

### Documentation

- [ ] `docs/auth-design.md` PendingLink section describes the verification step.
- [ ] `docs/email-setup.md` exists with DNS prerequisites, Resend onboarding, deliverability test recipe.
- [ ] PR2 description references PR1 and #80, attaches scenario results.

## Post-deployment (production) gate

- [ ] Operator confirms SPF/DKIM/DMARC pass on the configured `EMAIL_FROM` domain (mail-tester.com ≥ 9/10).
- [ ] First 7 days post-deploy: zero PendingLink rows committed without a successful prior email send (verified by sampling logs for missing `[email] sent` lines vs row counts).
- [ ] First 30 days: zero support reports of approval flows blocked because of stuck `email_verified_at IS NULL` rows after the user clicked the link (would indicate a UPDATE bug).
- [ ] Resend dashboard: bounce + complaint rate remain ≤ 1% combined.
- [ ] If false-positive 502s appear (provider transient errors), document the rate and consider Queue-based retry in a follow-up PR.
