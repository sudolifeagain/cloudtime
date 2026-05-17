# Feature Specification: Out-of-Band Email Verification for PendingLink Approval

**Feature Branch**: `080-out-of-band-email-verification`
**Created**: 2026-05-17
**Status**: Draft
**Input**: GitHub Issue #80 — Add out-of-band email verification for PendingLink approval

## Background

The current PendingLink flow (multi-user mode only) creates a merge candidate when a new OAuth login's verified email matches an existing user. Approval requires the existing user to log in and click "Approve" in the UI. Two defences are in place: manual user action, and dual `email_verified` checks against the OAuth provider.

[Truffle Security research (January 2025)](https://trufflesecurity.com/blog/google-oauth-is-broken-sort-of) demonstrated that even `email_verified: true` from OAuth providers is not proof of legitimate ownership — Google Workspace domain takeover and admin-provisioned accounts both produce verified email claims without the individual ever verifying.

This feature adds a **third layer of defence**: before approval can succeed, the system sends a one-time confirmation email to the existing user's address. The link in the email must be clicked from the recipient's inbox, proving they control the email account at the moment of merge.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Verified email recipient approves a merge (Priority: P1)

As Alice (existing user, registered with `alice@example.com` via GitHub), I receive a confirmation email when someone — including myself — initiates a Google login that resolves to my email. I click the link in the email from my inbox, then proceed to approve the merge inside the CloudTime UI. The merge only completes after both steps succeed.

**Why this priority**: This is the core security improvement. Without it, an attacker who controls a Workspace domain previously associated with my email can produce a `email_verified: true` token without ever having access to my inbox. Requiring inbox access closes that gap.

**Independent Test**: With email provider configured and multi-user mode enabled, complete a Google login for `alice@example.com` while Alice already exists via GitHub. Verify an email is sent, the link contains a unique token, clicking the link records `email_verified_at` on the `pending_links` row, and the approval endpoint then succeeds.

**Acceptance Scenarios**:

1. **Given** a PendingLink is created and the email provider succeeds, **When** the email is sent and Alice clicks the verify link within the token TTL, **Then** the PendingLink's `email_verified_at` is set and Alice's subsequent `POST /auth/link/approve/:pending_link_id` returns 200.
2. **Given** a PendingLink with `email_verified_at` not yet set, **When** Alice calls `POST /auth/link/approve/:pending_link_id`, **Then** the server returns 403 with body `{"error": "Email verification required"}` and the merge is **not** completed.
3. **Given** a verification token is consumed once successfully, **When** the same token URL is opened again, **Then** the server returns 410 Gone with body `{"error": "Token already used"}`.
4. **Given** a verification token has expired (configurable TTL, default 1 hour), **When** the link is opened, **Then** the server returns 410 Gone with body `{"error": "Token expired"}`.
5. **Given** a PendingLink is itself expired, **When** the verify endpoint is opened, **Then** the server returns 410 Gone (verification cannot resurrect an expired PendingLink).

---

### User Story 2 - Operator configures and validates the email provider (Priority: P1)

As an operator deploying CloudTime in multi-user mode, I configure my email provider once (Resend or Cloudflare Email Service), set the sender address, and verify deliverability by triggering a test merge.

**Why this priority**: Without a working provider, multi-user mode cannot create merge candidates safely. The deployment guide must produce a working pipeline on the first try.

**Independent Test**: Set `EMAIL_PROVIDER=resend`, `RESEND_API_KEY=...`, `EMAIL_FROM=noreply@example.com`. Trigger a PendingLink. Confirm the email arrives at the expected inbox, the From address matches, and the link points to the configured `APP_URL`.

**Acceptance Scenarios**:

1. **Given** `EMAIL_PROVIDER=resend` with a valid API key, **When** a PendingLink is created, **Then** an email is sent within one request cycle and a structured log line records the send.
2. **Given** `EMAIL_PROVIDER=resend` with an invalid API key, **When** a PendingLink is created, **Then** the system fails closed: the PendingLink row is rolled back (not committed) and the user-facing response is `502 Bad Gateway` with body `{"error": "Unable to send verification email; please try again later"}`.
3. **Given** `EMAIL_PROVIDER` is unset (default), **When** a PendingLink would normally be created, **Then** the system fails closed with `503 Service Unavailable` and the response body explains the operator must configure email.
4. **Given** the sender domain lacks SPF/DKIM, **When** the email is sent, **Then** delivery is best-effort; the server does not retry on bounces (out of scope), and the operator runbook documents DNS prerequisites.

---

### User Story 3 - Verification interaction works on mobile email clients (Priority: P2)

As Alice opening the verification email on a mobile inbox, I see a tappable link that works without requiring me to be signed into CloudTime in that browser session.

**Why this priority**: Mobile email clients often pre-fetch links; the verify endpoint must be idempotent on first call and explicit about replay. The endpoint must be reachable without a session cookie because the recipient may not have a CloudTime tab open on that device.

**Acceptance Scenarios**:

1. **Given** a verification email is opened on a mobile client that pre-fetches links, **When** the pre-fetch hits the verify endpoint, **Then** the token is consumed (first hit wins) and the user sees a "Verified — please return to CloudTime to approve" confirmation page. (Limitation acknowledged; documented in operator runbook.)
2. **Given** the verify endpoint, **When** any request method other than GET is used, **Then** the server returns 405 Method Not Allowed.

---

### Edge Cases

- **Single-user mode**: PendingLink is not used. The verify endpoint exists but never has rows to operate on; calls to `/auth/link/verify/:token` always return 410 Gone.
- **Operator changes provider mid-deployment**: Outstanding tokens issued by the previous provider still resolve normally (the verification is server-state-driven, not provider-state-driven). No data migration needed.
- **Email arrives after PendingLink expires**: Token resolves to a PendingLink row whose `expires_at` has passed. Server returns 410 Gone. Operator can re-trigger the merge by repeating OAuth login.
- **Same email triggers multiple PendingLinks**: Existing application limit (3 active pending links per user) already bounds the worst case. Each new PendingLink gets its own token and email; older tokens remain valid until expiry.
- **Spam folder**: Out of scope. Operator-side concern (DNS/sender reputation). Runbook documents SPF/DKIM/DMARC requirements.
- **Recipient does not have an inbox at the configured email**: The merge cannot proceed — which is exactly the intended security posture.
- **Email provider rate-limits us**: Best-effort. If the provider returns 429, the server fails closed and the operator may need to upgrade plans. Documented in the provider operator guide.
- **Replay attack with leaked email**: Token is consumed on first use; subsequent attempts return 410. Token entropy (32 bytes base64url) prevents brute-forcing within the TTL.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST send a verification email when a PendingLink row is created in multi-user mode. The email contains a one-time link `${APP_URL}/api/v1/auth/link/verify/:token` where `:token` is 32 random bytes encoded base64url.
- **FR-002**: The system MUST store only a SHA-256 hash of the token in `pending_links.email_verification_token_hash`. The plaintext appears only in the email body and is never logged or persisted.
- **FR-003**: The system MUST expose `GET /api/v1/auth/link/verify/:token` as an unauthenticated public endpoint. On a successful first hit within TTL, it MUST set `pending_links.email_verified_at` to the current timestamp and return a confirmation response (HTML page or 200 JSON, per operator deployment).
- **FR-004**: `POST /api/v1/auth/link/approve/:pending_link_id` MUST require `email_verified_at` to be non-null. If null, it MUST return `403 Forbidden` with body `{"error": "Email verification required"}` and not perform the merge.
- **FR-005**: The verification token MUST expire after a configurable TTL (default 3600 seconds). Expired tokens MUST return `410 Gone` with body `{"error": "Token expired"}`.
- **FR-006**: Tokens MUST be one-time. After successful verification, subsequent GETs of the same token MUST return `410 Gone` with body `{"error": "Token already used"}`. The replay check uses the existing `email_verified_at` field (non-null ⇒ already verified).
- **FR-007**: Email send failures MUST roll back the PendingLink creation (transactional). The OAuth callback that triggered the merge MUST return `502 Bad Gateway` with a non-leaky error message.
- **FR-008**: When `EMAIL_PROVIDER` is unset or empty, the system MUST fail closed: PendingLink creation returns `503 Service Unavailable` with body `{"error": "Email delivery not configured"}` and the row is not written.
- **FR-009**: The system MUST support at least one provider in the initial PR: **Resend** via REST API (env: `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM`).
- **FR-010**: The provider layer MUST be abstracted behind a single interface (`sendEmail(to, subject, html, text) → Promise<void>`) so additional adapters can be added without touching call sites.
- **FR-011**: The system MUST emit one structured log line per send attempt containing: provider name, recipient domain (not local part), pending link ID (UUID), and success/failure. The log MUST NOT contain the recipient's full email, the token plaintext, or the email body.
- **FR-012**: Single-user mode (`INSTANCE_MODE=single`) is unaffected; no emails are sent because no PendingLink is created. The verify endpoint MUST still exist but MUST always 410 in single-user mode.

### Non-Functional Requirements

- **NFR-001**: Email send must not block the OAuth callback for more than 2 seconds total. If the provider exceeds this budget, the send fails and the PendingLink is rolled back.
- **NFR-002**: The verification endpoint MUST be safe to call from email pre-fetchers (it is idempotent: first call wins, subsequent calls 410, no side effects from rejected calls).
- **NFR-003**: Token comparison MUST use constant-time equality against the stored hash. Hash lookup uses SHA-256 of the URL token.
- **NFR-004**: The verify endpoint MUST be exempt from CSRF (it is `GET` and never a state-changing form). State change (`email_verified_at` update) is acceptable on GET because the token itself is the proof.

### Key Entities *(D1 schema change)*

Add two columns to `pending_links`:
- `email_verification_token_hash TEXT` — nullable, populated on creation with `sha256(token)`.
- `email_verified_at TEXT` — nullable, set to `datetime('now')` on successful verify.

Indexes:
- `idx_pending_links_token_hash` on `email_verification_token_hash` for the verify endpoint's lookup.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With `EMAIL_PROVIDER=resend` configured, end-to-end merge takes ≤ 30 seconds from OAuth callback to approve success (most of that being human time to read the email).
- **SC-002**: PendingLink rows with `email_verified_at IS NULL` cannot be approved (verified by attempting the approve endpoint and observing 403).
- **SC-003**: Adding a second provider adapter touches only `src/utils/email/<provider>.ts`, plus an entry in the provider selector. No call site changes outside the email module.
- **SC-004**: When email provider returns 5xx, no `pending_links` row exists in D1 after the failure (verified via post-failure SELECT).
- **SC-005**: Operator runbook covers DNS setup (SPF/DKIM/DMARC) so a fresh deployment can pass an inbox deliverability test with mail-tester.com or equivalent within the first hour.

## Out of Scope

- **Email sending for any flow other than PendingLink verification**. Password reset, welcome emails, security alerts, etc. are not added in this PR.
- **Bounce / complaint webhook handling**. Operators must monitor their provider dashboard. A future PR may add a webhook receiver.
- **Retry/queue for transient send failures**. Workers Queues integration is out of scope; failures are immediate and the user must re-trigger.
- **HTML email templates with branding**. The initial template is minimal: plain text with a single link plus a one-line HTML wrapper.
- **Per-user opt-out / unsubscribe**. Verification emails are mandatory and transactional, not marketing.
- **Multi-language email content**. English only; localisation is a separate feature.
