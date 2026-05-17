# Email Setup for Operators

This guide covers the email delivery pipeline used by the out-of-band
PendingLink verification flow (Issue #80). It applies only when running in
multi-user mode (`INSTANCE_MODE=multi`). Single-user instances do not send
email and may skip this document entirely.

## Provider support

| Provider | Status | Env value |
|---|---|---|
| Resend | Supported | `EMAIL_PROVIDER=resend` |
| Cloudflare Email Service | Planned (after GA) | `EMAIL_PROVIDER=cloudflare` |
| AWS SES | Planned | `EMAIL_PROVIDER=ses` |

Other providers (MailChannels, SendGrid, Mailgun, Postmark) are intentionally
not supported as of this writing; see
`specs/080-out-of-band-email-verification/research.md` for rationale.

## Required configuration

Set the following variables via `wrangler secret put` (or `[vars]` for
non-secret values):

```text
EMAIL_PROVIDER   # one of: resend
EMAIL_FROM       # e.g. "noreply@cloudtime.example.com"
RESEND_API_KEY   # bearer token from https://resend.com/api-keys
```

`EMAIL_FROM` must be on a domain you control. The sending domain must pass
SPF, DKIM, and (recommended) DMARC checks for the recipient's mail server to
accept the message. Resend's domain-verification onboarding walks through
the required DNS records.

## DNS records (one-time per sending domain)

| Record | Purpose |
|---|---|
| MX (optional) | Required if you want bounces handled by your own mail server. Resend can host bounces if you skip this. |
| SPF | TXT record permitting Resend to send as your domain. |
| DKIM | Public key Resend publishes on your behalf; sign every outgoing message. |
| DMARC | Policy record telling recipients what to do when SPF/DKIM fail. Start with `p=none` to monitor, then tighten. |

Validate end-to-end with [mail-tester.com](https://mail-tester.com) before
relying on the deployment. A score of 9+/10 is the operational target.

## Behaviour summary

1. PendingLink would be created (multi-user mode + matched verified email).
2. Server generates a 32-byte token, builds a verify URL on `APP_URL`, and
   calls `sendEmail()`.
3. On success, the PendingLink row is INSERTed with the SHA-256 hash of the
   token and `email_verified_at = NULL`.
4. The recipient opens the link from their inbox. The first hit consumes the
   token via `UPDATE ... SET email_verified_at = datetime('now') ...
   RETURNING id` and returns a small HTML confirmation page.
5. The user returns to CloudTime and calls
   `POST /api/v1/auth/link/approve/{pending_link_id}` to complete the merge.

## Failure modes

| Condition | Response | DB effect |
|---|---|---|
| `EMAIL_PROVIDER` unset | 503 Service Unavailable | No row written |
| `EMAIL_PROVIDER=resend` but `RESEND_API_KEY` missing | 503 Service Unavailable | No row written |
| Provider returns non-2xx | 502 Bad Gateway | No row written |
| Send exceeds 2-second budget | 502 Bad Gateway | No row written |
| User clicks link → success | 200 HTML confirmation | `email_verified_at` set |
| User clicks already-verified link | 410 Gone (`"Token already used"`) | No change |
| User clicks expired link | 410 Gone (`"Token expired"`) | No change |
| User clicks unknown link | 410 Gone (`"Token not found"`) | No change |
| Approve before verification | 403 Forbidden (`"Email verification required"`) | No merge |

## Log fields

Successful send:

```
[email] sent provider=resend pending_link=<uuid> recipient_domain=example.com
```

Failure or misconfiguration:

```
[email] not configured — refusing PendingLink for recipient_domain=example.com
[email] send failed recipient_domain=example.com status=401 message=…
```

The recipient's full address, the token plaintext, and the email body are
**never** logged.

## Operator runbook

- **Daily**: tail Worker logs for `[email]` entries. Any `send failed` should
  be investigated immediately.
- **Weekly**: check the Resend dashboard for bounce / complaint rates.
  Sustained values above 1% combined suggest sender-reputation problems.
- **On domain change**: re-run mail-tester.com against `EMAIL_FROM`. Update
  SPF / DKIM / DMARC records as Resend instructs.

## Mobile pre-fetch caveat

Some mobile email clients pre-fetch links to detect phishing. A pre-fetch
will consume the token, and when the user later taps the link they will see
410 ("Token already used"). The token still served its security purpose
(only an inbox holder could have triggered the pre-fetch). If users report
this confusion frequently, consider switching to an explicit confirmation
page that requires a user-initiated POST. This is documented as a known
trade-off in `specs/080-out-of-band-email-verification/research.md`
Decision 4.

## Cost expectations

Resend's free tier (3,000 emails/month) covers the expected volume of
PendingLink verifications even for a 1,000-user instance — these emails are
only triggered on account merge events. See
`specs/080-out-of-band-email-verification/research.md` for the full
provider comparison.
