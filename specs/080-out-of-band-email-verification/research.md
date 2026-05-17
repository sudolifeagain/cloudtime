# Research: Out-of-Band Email Verification for PendingLink Approval

## Decision 1: Provider choice — Resend as the day-one adapter

**Decision**: Ship a single provider adapter (Resend) in the initial PR. Design the interface so additional providers can be added without touching call sites.

**Rationale**:
- **Volume**: PendingLink emails are rare. Even a 100-user multi-user instance generates ~0-10 sends/month (only on account merge events). Every provider's free tier covers this trivially.
- **Workers DX**: Resend exposes a flat REST API at `POST https://api.resend.com/emails` that `fetch()` can call directly with a bearer token. No SDK, no SigV4, no SMTP. Compatible with the 10ms CPU budget.
- **Free tier durability**: 3,000 emails/month with no time limit (as of 2026-05). Free tier removals (SendGrid in 2025-05) make picking a tier-stable provider important.
- **Self-hosted ethos**: Resend's API model lets operators bring their own API key without depending on a Cloudflare account upgrade.

**Alternatives considered and deferred**:
1. **Cloudflare Email Service** (binding `send_email`): currently public beta with API surface that may change before GA. Requires Workers Paid plan ($5/mo) even for free senders. Will add as a second adapter once it reaches GA.
2. **AWS SES**: cheapest at scale ($0.10/1k) but requires SigV4 request signing in Workers (~150 LoC), sandbox-to-production application flow, and SNS bounce wiring. Worth supporting eventually for high-volume self-hosters; not the first adapter.
3. **MailChannels**: deliberately excluded — the Cloudflare Workers integration was sunset 2024-08, current API has a credit-card-required free tier with restrictive limits.
4. **SendGrid / Mailgun / Postmark**: all have either no free tier (SendGrid post-2025-05) or trial-only access (Mailgun). Operator burden is no lower than Resend.

---

## Decision 2: Fail closed on provider failure or misconfiguration

**Decision**: When the configured provider returns an error, when no provider is configured, or when the send exceeds a 2-second budget, the system rolls back the PendingLink row and returns 502 (provider error) or 503 (unconfigured) to the user.

**Rationale**:
- The whole point of this feature is to harden merge approval. Silently downgrading to "no email check" defeats the security goal.
- A failed send leaves the user with a clear error and a retry path (re-trigger OAuth). The alternative — committing the row without sending — produces an unrecoverable PendingLink the user cannot approve.
- D1 transactional semantics: we generate the token, attempt the send, and only insert on success. If the send fails, no row exists and no token is leaked.

**Alternatives considered**:
1. **Fail open with a flag**: rejected — defeats the security model.
2. **Queue the send via Cloudflare Queues**: rejected for PR1 — Queues adds a paid binding requirement and complicates failure attribution. May revisit if 2-second budgets become problematic.

---

## Decision 3: Token in URL, hash in DB

**Decision**: Token is 32 random bytes encoded base64url. URL form: `${APP_URL}/api/v1/auth/link/verify/${token}`. Database stores SHA-256 hash of the token.

**Rationale**:
- 32 bytes (256 bits) of entropy makes the token unguessable inside the 1-hour TTL window even if all PendingLinks were active simultaneously.
- Hash-only storage matches the project's existing conventions (`api_key_hash`, `sessions.token_hash`). DB compromise does not leak working tokens.
- URL-borne tokens are visible to TLS-intermediating proxies and browser history. Acceptable trade-off because the token is single-use and short-lived; the email client (HTTPS to provider) is the most exposed link.

**Alternatives considered**:
1. **Token as a query parameter (`?token=...`) instead of path**: rejected — path segments are not logged by default in many proxies/CDNs, query strings frequently are. Path segment is the safer choice.
2. **Encrypted token containing the pending_link_id**: rejected — adds complexity and a key-management burden for no security gain. Random token + DB lookup is the standard pattern.

---

## Decision 4: GET endpoint with single-use semantics

**Decision**: `GET /auth/link/verify/:token` is the verification endpoint. First successful hit sets `email_verified_at`; subsequent hits return 410 Gone.

**Rationale**:
- Email clients open links via GET. Forcing POST would require an intermediate "click here to verify" form, which adds friction and is hostile to mobile clients.
- Token consumption is implemented via `UPDATE pending_links SET email_verified_at = datetime('now') WHERE email_verification_token_hash = ? AND email_verified_at IS NULL` returning `meta.changes`. If `changes == 0`, the row either does not exist or was already verified — both 410 cases.
- The endpoint is CSRF-safe by construction: it is purely state-change-on-GET, but the state change is gated on the unforgeable token itself.

**Pre-fetch caveat**: Some mobile email clients pre-fetch links. The first pre-fetch consumes the token; the user's later click sees 410. This is an industry-wide constraint and is documented in the operator runbook. We accept it because the alternative (requiring user-initiated POST) breaks mobile email entirely.

**Alternatives considered**:
1. **Two-step flow: GET shows a confirmation page, POST consumes the token**: rejected — too much UX surface for a transactional verification flow.
2. **Token consumed only on POST after a "Confirm" button click**: rejected — pre-fetch problem still exists if the page itself auto-posts; if not, mobile UX is poor.

---

## Decision 5: TTL aligned with PendingLink expiry (1 hour default)

**Decision**: Token TTL equals the PendingLink's `expires_at` (default 1 hour). The token cannot outlive the row.

**Rationale**:
- Single TTL source of truth: when the PendingLink expires, the token also expires. Cleanup is automatic.
- 1 hour is enough for a user to switch tabs, read email, and act, while short enough that compromised inboxes do not yield long-lived tokens.
- Existing cron-purge of expired PendingLinks (`DELETE FROM pending_links WHERE expires_at < datetime('now')`) doubles as token cleanup.

**Alternatives considered**:
1. **Independent token TTL**: rejected — doubles the lifecycle bookkeeping.
2. **Configurable per-deployment TTL**: rejected for PR1 — `pending_links.expires_at` already encodes the lifetime; a separate env var would invite drift.

---

## Decision 6: Confirmation response — minimal HTML

**Decision**: The verify endpoint returns a small HTML page on success: a single sentence telling the user to return to CloudTime to approve, plus a link back to `APP_URL`. Failure cases return JSON.

**Rationale**:
- The user lands on this URL from an email client, often in a browser they may not have a CloudTime session in. A JSON response would feel broken.
- HTML keeps the surface minimal (one `<h1>` and a `<p>`) and survives Content-Security-Policy `default-src 'none'` because it has no external resources.
- Failure paths (410, 405) keep JSON to match the rest of the API; that response is consumed by curl-style retries during testing, not by humans.

**Alternatives considered**:
1. **JSON for both success and failure**: rejected — humans land on the success path, machines do not.
2. **Redirect to a frontend route**: rejected — CloudTime has no frontend yet; the success page lives in the Worker.

---

## Decision 7: Provider selector via `EMAIL_PROVIDER` env var, not auto-detect

**Decision**: Operators explicitly set `EMAIL_PROVIDER=resend` (or future values). Auto-detect from presence of `RESEND_API_KEY` is intentionally not supported.

**Rationale**:
- Explicit beats implicit. An operator who removes a Resend key intending to switch providers should not silently fall through to the next auto-detected adapter.
- If `EMAIL_PROVIDER` is set but the matching credentials are missing (e.g., `EMAIL_PROVIDER=resend` without `RESEND_API_KEY`), the system fails closed on the next send attempt with a clear error.

**Alternatives considered**:
1. **Auto-detect by env var presence**: rejected — error-prone during operator transitions.

---

## Decision 8: No retry on transient send failures

**Decision**: A single send attempt with a 2-second timeout. No automatic retry. Failure rolls back the PendingLink and surfaces the error to the user, who re-triggers via OAuth.

**Rationale**:
- Workers Queues (the obvious retry path) is a paid binding and adds operator burden.
- The user who triggered the merge is in the loop; they can retry by attempting OAuth login again, which produces a fresh PendingLink and a fresh send.
- Most transient failures (provider 5xx, network blip) are observable enough through the structured log that operators can investigate without an automated retry.

**Alternatives considered**:
1. **In-process retry with backoff**: rejected — Worker CPU budget too tight, retries consume budget that should serve other requests.
2. **Queue-based async retry**: rejected for PR1; revisit if production data shows transient-failure rate is meaningful.
