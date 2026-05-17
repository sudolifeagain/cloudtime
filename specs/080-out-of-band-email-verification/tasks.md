# Tasks: Out-of-Band Email Verification for PendingLink Approval

**Branch**: `080-out-of-band-email-verification`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Generated**: 2026-05-17

## PR1 — Spec + Design

- [x] **T-001**: Author `spec.md` covering FR-001..FR-012, NFRs, edge cases, success criteria.
- [x] **T-002**: Author `plan.md` with Constitution Check and design sketch.
- [x] **T-003**: Author `research.md` documenting 8 decisions (provider, fail mode, token shape, etc.).
- [x] **T-004**: Author `quickstart.md` with scenarios A–H.
- [x] **T-005**: Author `data-model.md` covering the two new `pending_links` columns.
- [x] **T-006**: Author `contracts/openapi-diff.md` describing the new path and 410 response.
- [x] **T-007**: Author `checklists/requirements.md` (PR1/PR2/post-deploy gates).
- [ ] **T-008**: Add `schemas/components/responses/Gone.yaml` (new shared 410 response component).
- [ ] **T-009**: Add `schemas/paths/auth/link-verify-token.yaml` (`GET /auth/link/verify/{token}` operation, `security: []`, 200/410/405 responses, `Gone.yaml` ref).
- [ ] **T-010**: Wire the new path in `schemas/openapi.yaml` under `paths`.
- [ ] **T-011**: Add `migrations/0002_pending_link_email_verification.sql` (ALTER TABLE + CREATE INDEX). Also update `src/db/schema.sql` so fresh deployments include the columns.
- [ ] **T-012**: Update `schemas/components/schemas/PendingLink.yaml` (if it exists) or the inline schema, exposing `email_verified_at` as a nullable read-only field on the approve endpoint context where relevant.
- [ ] **T-013**: Run `npm run generate` and verify the diff in `src/types/generated.ts` is additive only (new operation, new response type, new optional field).
- [ ] **T-014**: Commit PR1 in two commits: `spec:` for SpecKit + schema + migration, `chore:` for generated types. Push, open PR against `develop`.

## PR2 — Implementation (after PR1 merges)

### Email provider abstraction

- [ ] **T-101**: Add `EMAIL_PROVIDER?: string`, `EMAIL_FROM?: string`, `RESEND_API_KEY?: string` to `Env` in `src/types.ts`.
- [ ] **T-102**: Create `src/utils/email/types.ts` exporting `EmailMessage` and `EmailProvider` interfaces, plus error classes `EmailNotConfiguredError` and `EmailSendError`.
- [ ] **T-103**: Create `src/utils/email/resend.ts` implementing `EmailProvider`. Single `fetch()` to `https://api.resend.com/emails` with bearer auth, 2-second `AbortSignal.timeout(2000)`. Throw `EmailSendError` on non-2xx.
- [ ] **T-104**: Create `src/utils/email/index.ts` exporting `sendEmail(env, msg)` that selects provider by `env.EMAIL_PROVIDER`. Returns `EmailNotConfiguredError` when unset.

### Token & DB layer

- [ ] **T-105**: Add helper `generateVerificationToken()` in `src/utils/crypto.ts` returning `{ plaintext, hash }` (32 random bytes, base64url, SHA-256).
- [ ] **T-106**: Update `src/routes/auth/login.ts` PendingLink branch to:
  1. Move/introduce the `INSTANCE_MODE` check before same-email PendingLink creation so single-user mode never sends email and never writes `pending_links`.
  2. Generate token before INSERT.
  3. Build the email body (plain text + minimal HTML) including the verify link.
  4. Call `sendEmail(env, msg)` BEFORE the D1 INSERT.
  5. Only INSERT when the send resolves; store `email_verification_token_hash`.
  6. On `EmailSendError`, return 502; on `EmailNotConfiguredError`, return 503. No partial state.

### Verify endpoint

- [ ] **T-107**: Add `link.get("/link/verify/:token", ...)` in `src/routes/auth/link.ts` (public, no session middleware, no rate-limit middleware in PR2 — follow-up). Add an explicit non-GET handler for the same path (for example `link.all("/link/verify/:token", ...)` after the GET route) returning 405.
- [ ] **T-108**: Implement the lookup as a single UPDATE-with-RETURNING:
  ```sql
  UPDATE pending_links
  SET email_verified_at = datetime('now')
  WHERE email_verification_token_hash = ? -- SHA-256(url token), indexed equality lookup
    AND email_verified_at IS NULL
    AND expires_at > datetime('now')
  RETURNING id
  ```
  - `meta.changes === 1`: success ⇒ return HTML confirmation page.
  - `meta.changes === 0`: distinguish "not found / already verified / expired" via a follow-up SELECT, return 410 with the appropriate body.
  - Do not load the stored hash for application-level token comparison; the URL token is hashed once and matched by indexed SQL equality.

- [ ] **T-108a**: Ensure global CSRF middleware cannot convert non-GET verify requests into 403. Either exempt `/api/v1/auth/link/verify/*` before CSRF runs or mount the verify method-dispatch before CSRF; Scenario H must return 405 for a plain `curl -X POST` with no `Origin`.

### Approve endpoint gate

- [ ] **T-109**: In `src/routes/auth/link.ts` `POST /link/approve/:pending_link_id`, check `email_verified_at IS NOT NULL` before proceeding. If null, return 403 with `{"error": "Email verification required"}`.

### Documentation

- [ ] **T-110**: Update `docs/auth-design.md` PendingLink section to describe the verification step.
- [ ] **T-111**: Add `docs/email-setup.md` operator runbook: DNS (SPF/DKIM/DMARC), Resend onboarding, troubleshooting, deliverability test with mail-tester.com.

### Tests

- [ ] **T-112**: Unit test for `src/utils/email/resend.ts` — mock `globalThis.fetch`, verify request shape, error handling, timeout behaviour.
- [ ] **T-113**: Unit test for `src/utils/email/index.ts` provider selector — unset, unknown value, configured.
- [ ] **T-114**: Integration test in `tests/integration/pending-link-verify.test.ts`:
  - Happy path: seed PendingLink with known token hash, GET verify URL, assert `email_verified_at` set.
  - Replay: second GET returns 410.
  - Expired row: pre-aged `expires_at`, returns 410.
  - Approve before verify: 403.
  - Non-GET verify request returns 405 even without `Origin` headers.
  - Single-user same-email OAuth regression: no PendingLink row is created and no email send is attempted.

### Verification

- [ ] **T-115**: `npx tsc --noEmit` — zero errors.
- [ ] **T-116**: `npm test` — all suites pass including new tests.
- [ ] **T-117**: Run quickstart scenarios A–H against a deployed staging Worker with Resend; attach screenshots/log excerpts to the PR.

### PR2 submission

- [ ] **T-118**: Commit with `feat:` prefix. Push, open PR against `develop` referencing #80 and PR1.

## Dependencies

```
T-001..T-007  → T-008..T-012 → T-013 → T-014  (PR1)
T-014 → T-101..T-118  (PR2 starts after PR1 merge)
T-102 → T-103 → T-104  (provider stack)
T-104 → T-106 (call site needs the surface)
T-105 → T-106 (token helper before use)
T-106 → T-107 (DB column must exist before verify endpoint reads it)
T-107 → T-108a → T-109 (method handling and approve gate piggyback on verify-set column)
T-103/T-104 → T-112/T-113  (tests follow code)
T-106/T-107/T-109 → T-114  (integration test needs all three branches)
T-115/T-116 → T-117 → T-118
```

## Out of scope (do not implement in this feature)

- Cloudflare Email Service adapter (binding-based; add after GA).
- AWS SES adapter (SigV4 implementation; future PR).
- Bounce / complaint webhook handling.
- Workers Queues retry of failed sends.
- Branded HTML email templates.
- Per-user unsubscribe (these are transactional, not marketing).
- Email locales other than English.
- Rate limiting on the verify endpoint (the token's entropy is the protection; rate limit is follow-up if abuse appears).
