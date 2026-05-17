# Quickstart: Verify Out-of-Band Email Verification

This guide walks through manually verifying the email-verification step in the PendingLink approval flow once PR2 (implementation) is deployed.

## Prerequisites

- Multi-user instance (`INSTANCE_MODE=multi`) — single-user mode does not use PendingLink.
- Email provider configured. For the initial implementation:
  - `EMAIL_PROVIDER=resend`
  - `RESEND_API_KEY=<your Resend key>`
  - `EMAIL_FROM=noreply@<your verified domain>` — domain must be added and DNS-verified in your Resend dashboard.
- `APP_URL` is set to a publicly reachable origin (the verify link points here).
- Two OAuth provider accounts that share an email address (e.g., a GitHub account and a Google account both bound to `alice@example.com`).

## DNS prerequisites (one-time)

Set up SPF, DKIM, and DMARC for `<your verified domain>` per Resend's domain verification flow. Verify deliverability with a test send before running these scenarios.

## Scenario A — Happy path

1. As `alice@example.com`, log in via GitHub. A user row is created.
2. Log out.
3. Log in via Google, again as `alice@example.com`. Server detects the email match and creates a PendingLink. The OAuth callback response contains the `pending_link.id`.
4. Within ≤ 30 seconds, an email arrives at `alice@example.com`:
   - From: `EMAIL_FROM`
   - Subject: contains "Confirm CloudTime account link"
   - Body: contains a single link `${APP_URL}/api/v1/auth/link/verify/<token>`
5. Open the link in any browser (no session required).
6. Browser shows a confirmation page: "Email verified. Return to CloudTime to approve the merge."
7. Log into CloudTime as Alice (GitHub session). Call `POST /api/v1/auth/link/approve/<pending_link_id>`.

**Expected**:
- Step 4 server log includes one structured line: `[email] sent provider=resend pending_link=<uuid> recipient_domain=example.com`. No full email address in the log.
- Step 6 D1 state: `pending_links.email_verified_at` is non-null.
- Step 7 response: 200, merge completed; new `oauth_accounts` row links Google to Alice's user.

## Scenario B — Approve before verification

Skip step 5 in Scenario A. Immediately call `POST /api/v1/auth/link/approve/<pending_link_id>`.

**Expected**:
- 403 Forbidden, body `{"error": "Email verification required"}`.
- No merge performed.
- D1 state: `pending_links.email_verified_at` still null.

## Scenario C — Token replay

In Scenario A, after step 6, open the same verify URL a second time.

**Expected**:
- 410 Gone, body `{"error": "Token already used"}`.
- `email_verified_at` remains unchanged (idempotent).

## Scenario D — Token expiry

Trigger a PendingLink as in Scenario A. Wait 60+ minutes. Open the verify URL.

**Expected**:
- 410 Gone, body `{"error": "Token expired"}` (the underlying row's `expires_at` has passed, so the token cannot be honoured).
- The cron purge will eventually delete the row.

## Scenario E — Email provider failure (transient)

Temporarily set `RESEND_API_KEY` to an invalid value, then trigger a Google OAuth login for an email that matches an existing user.

**Expected**:
- OAuth callback response: 502 Bad Gateway, body `{"error": "Unable to send verification email; please try again later"}`.
- D1 state: no new `pending_links` row exists.
- Server log includes the provider error code (Resend's response body, sanitised).

## Scenario F — Email provider not configured

Unset `EMAIL_PROVIDER`. Trigger a Google OAuth login for an email that matches an existing user.

**Expected**:
- OAuth callback response: 503 Service Unavailable, body `{"error": "Email delivery not configured"}`.
- D1 state: no new `pending_links` row exists.
- Server log includes a one-time warning per isolate that email is unconfigured.

## Scenario G — Single-user mode is unaffected

Switch the instance to `INSTANCE_MODE=single`. Confirm OAuth login flows still work for the owner. Visit `${APP_URL}/api/v1/auth/link/verify/anything`.

**Expected**:
- OAuth login: completes normally for the existing owner; no PendingLink is created.
- Verify endpoint: 410 Gone, body `{"error": "Token not found"}`. No emails are sent.

## Scenario H — Method other than GET

```bash
curl -X POST ${APP_URL}/api/v1/auth/link/verify/anything
```

**Expected**: 405 Method Not Allowed.

## Tuning operator runbook checks

After running Scenarios A–H once successfully, add the deployment to your monitoring checklist:

1. **Daily**: tail Worker logs filtered for `[email]` lines; any provider errors should be investigated.
2. **Weekly**: check Resend dashboard for bounce/complaint rate. Sustained bounces over 1% suggest DNS or sender-reputation issues.
3. **On every domain change**: re-run mail-tester.com against the configured `EMAIL_FROM` to confirm SPF/DKIM/DMARC alignment.
