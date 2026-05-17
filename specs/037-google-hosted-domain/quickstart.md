# Quickstart: Verify Google Hosted Domain Restriction

This guide walks through manually verifying the `GOOGLE_HOSTED_DOMAIN` behavior introduced by this feature. It assumes PR2 (implementation) is deployed.

## Prerequisites

- Google Cloud Console project with two test users available:
  - A Google Workspace user under `<your-test-domain>` (e.g., `alice@example-corp.com`)
  - A personal Gmail account (e.g., `tester+personal@gmail.com`)
- CloudTime deployed to a Cloudflare Worker with Google OAuth secrets configured.
- `wrangler` CLI authenticated.

## Scenario A — Restriction enabled, matching domain ⇒ success

```bash
wrangler secret put GOOGLE_HOSTED_DOMAIN  # enter: example-corp.com
wrangler deploy
```

Open `https://<your-worker>/api/v1/auth/google` in a browser. Complete OAuth as `alice@example-corp.com`.

**Expected**:
1. The browser is redirected to `https://accounts.google.com/o/oauth2/v2/auth?...&hd=example-corp.com&...` — the `hd` hint is present.
2. The Google account picker defaults to Workspace accounts.
3. After consent, the callback returns 200 (or sets a session cookie + redirects, depending on flow).
4. A `users` row is created (or matched, for repeat login).

## Scenario B — Restriction enabled, non-matching domain ⇒ 403

Stay logged into Google as `alice@example-corp.com` initially, but on the consent screen, switch to or sign in with a personal `tester+personal@gmail.com` account (the user has the right to override `hd`).

**Expected**:
1. Google still completes the authorization flow and redirects to the callback.
2. The callback returns:
   - `HTTP/2 403`
   - `cache-control: no-store`
   - body: `{"error":"Account domain not allowed"}`
3. No row is created in `users` or `oauth_accounts`. Verify with:
   ```bash
   wrangler d1 execute cloudtime-db --remote --command="SELECT id, email FROM users WHERE email = 'tester+personal@gmail.com'"
   ```
   Expected: 0 rows.
4. Worker logs (`wrangler tail`) show exactly one line of shape:
   `[google-hosted-domain] rejected rule=google-hosted-domain reason=hd-missing expected=example-corp.com`
   The log MUST NOT contain `tester+personal@gmail.com`, the `id_token`, or the Google `sub`.

## Scenario C — Restriction enabled, different Workspace domain ⇒ 403

If you have a second Workspace domain available (e.g., `bob@other-corp.com`), repeat Scenario B with that user.

**Expected**:
- Same `403` response.
- Log line shows `reason=hd-mismatch` (not `hd-missing`) and `expected=example-corp.com`.

## Scenario D — Restriction disabled (env var unset) ⇒ all logins accepted

```bash
wrangler secret delete GOOGLE_HOSTED_DOMAIN
wrangler deploy
```

Repeat Scenario B with a personal Gmail account.

**Expected**:
1. The authorization URL does **not** contain `hd=` (URL inspectable via browser dev tools or `curl -I`).
2. The callback returns 200 (or normal flow) and creates/matches a `users` row.
3. Behavior is byte-identical to pre-feature behavior.

## Scenario E — Case-insensitive comparison

```bash
wrangler secret put GOOGLE_HOSTED_DOMAIN  # enter: Example-Corp.COM (mixed case)
wrangler deploy
```

Complete OAuth as `alice@example-corp.com`.

**Expected**:
- Login succeeds. Case-insensitive comparison treats `Example-Corp.COM` (config) and `example-corp.com` (token claim) as equal.

## Scenario F — TypeScript compile check

```bash
npx tsc --noEmit
```

**Expected**: Exit code 0, no errors.

## Reverting

```bash
wrangler secret delete GOOGLE_HOSTED_DOMAIN
wrangler deploy
```

Or set to empty (functionally equivalent for the runtime check, but `delete` is cleaner).

## Notes for operators

- **You cannot retrofit this onto an existing instance with mixed-domain users.** Adding the env var after onboarding will silently block any user whose `hd` does not match. Communicate the change before rolling out.
- **The single-user mode "Registration closed" 403 and the hosted-domain 403 share the same HTTP status but different error bodies.** Operators reading logs/responses should distinguish on body content.
- **Multi-domain support is not provided.** If your organization owns multiple Workspace domains, place the Worker behind Cloudflare Access or another upstream filter and leave `GOOGLE_HOSTED_DOMAIN` unset.
