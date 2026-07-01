# Authentication & Session Design

## Overview

cloudtime uses OAuth 2.0 with PKCE for user authentication. Three providers are supported:
- GitHub
- Google
- Discord

One user account can link multiple OAuth providers. Editor plugins use a permanent UUID API key.

## Instance Modes

Controlled by `INSTANCE_MODE` environment variable:

### Single-User Mode (default: `INSTANCE_MODE=single`)

- **First OAuth login** creates the owner. Only one user row ever exists.
- **Subsequent logins** must match an existing `oauth_account` for the owner. Unknown accounts are rejected (403).
- **Linking providers** always links to the owner — no merge approval flow needed.
- **Leaderboards, organizations, team dashboards** are disabled (endpoints return 404).
- DB schema is identical to multi-user mode (all tables have `user_id`), so upgrading is a config change.

### Multi-User Mode (future: `INSTANCE_MODE=multi`)

- **OAuth login** creates a new user if the `oauth_account` doesn't exist.
- **Same-email merge** — if a new OAuth email matches an existing user, a `pending_link` is created and the user must approve the merge.
- **Leaderboards, organizations, team dashboards** are enabled.
- Invite-based or open registration (configurable).

## Authentication Methods

| Context | Method | Lifetime |
|---------|--------|----------|
| Editor plugins | UUID API key via Basic Auth / Bearer | Permanent (until regenerated) |
| Web UI | Session cookie (`__Host-session`) | 24h idle / 7d absolute |
| OAuth flow | PKCE + state parameter | One-time |

## OAuth Flow

### First Login

```
1. GET /api/v1/auth/github
   - Generate PKCE code_verifier + code_challenge
   - Generate random state parameter
   - Store code_verifier + state in KV (TTL: 10 min)
   - Set encrypted cookie with state
   - 302 → GitHub authorize URL with code_challenge

2. GET /api/v1/auth/github/callback?code=...&state=...
   - Verify state matches cookie
   - Exchange code + code_verifier for access_token
   - Fetch user info from provider API
   - Check if oauth_account exists:
     a) YES → Login existing user
     b) NO + email matches existing user → Create PendingLink
     c) NO + new email → Create new user + oauth_account
   - Create session in DB (store SHA-256 of token)
   - Set __Host-session cookie (HttpOnly, Secure, SameSite=Lax, Path=/)
   - Return user + api_key
```

### Account Linking

```
1. POST /api/v1/auth/link/discord  (authenticated)
   - Same OAuth redirect but with link_to=<user_id> in state

2. GET /api/v1/auth/link/discord/callback
   - Verify authenticated user
   - Add oauth_account linked to current user_id
   - If provider_user_id already linked to different user → 409
```

**Single-user mode:** Linking always targets the owner. No 409 possible (only one user exists).

### Account Merge (same email from different provider)

**Multi-user mode only:**
```
1. User registered via GitHub (email: alice@example.com, email_verified: true)
2. Tries to login with Google (same email: alice@example.com)
3. System checks DUAL email verification:
   a) Existing user's email_verified must be true
   b) Incoming provider must report email as verified
4. If BOTH verified → send out-of-band verification email FIRST, then on
   success create PendingLink (TTL: 1 hour, see Issue #80)
   If EITHER unverified → create new user account instead (no PendingLink)
5. Returns pending_link with existing_username
6. Recipient opens the verification link from their inbox →
   pending_links.email_verified_at is set
7. User calls POST /api/v1/auth/link/approve/{pending_link_id}
   (returns 403 "Email verification required" if step 6 has not occurred)
8. OAuth account is linked to existing user
9. User is logged in as existing account
```

**Out-of-band email verification (Issue #80)**: This is the third defence on
top of "dual `email_verified` check" and "manual approval". Even when a
provider reports `email_verified: true`, the existing user must prove inbox
access before approval is honoured. The verification email is sent BEFORE the
PendingLink row is committed — if the send fails or the provider is not
configured, no row is written. See [email-setup.md](./email-setup.md) for
operator configuration and `specs/080-out-of-band-email-verification/`.

**email_verified behavior:**
- Set on user creation based on the OAuth provider's report.
- Updated on each login: uses a **high-water mark** approach — once verified (`true`), never downgraded back to `false`. Only upgrades (false → true) are applied. This follows industry best practices (Auth0, Firebase, Clerk).
- Provider-specific extraction: GitHub requires `GET /user/emails` (primary email's `verified` field), Google returns `email_verified` or `verified_email` depending on endpoint, Discord returns `verified` (absent without `email` scope, treated as `false`).

**Single-user mode:** The same-email merge branch is gated on `INSTANCE_MODE=multi`. In single-user mode the PendingLink path is never entered — a second OAuth login that resolves to a different `(provider, provider_user_id)` falls through to the single-user gate (`WHERE (SELECT COUNT(*) FROM users) = 0`) which returns 403 "Registration closed". Operators who want a second provider linked to the owner must use `POST /api/v1/auth/link/{provider}` (session required), not the implicit same-email flow. The verification-email pipeline is therefore inert in single-user mode and `EMAIL_PROVIDER` need not be set.

## Session Security

| Property | Value |
|----------|-------|
| Cookie name | `__Host-session` (`__Host-` prefix enforces Secure, Path=/, no Domain) |
| Cookie flags | `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/` |
| Token format | 32 bytes random (Web Crypto `getRandomValues`), base64url |
| Storage | SHA-256 hash in `sessions` table (never plaintext) |
| Idle timeout | 24 hours (`last_active_at` updated on each request) |
| Absolute expiry | 7 days from creation |
| Revocation | DELETE /auth/session removes from DB |
| Cleanup | Cron purges expired sessions hourly |

### Note: `SameSite=Lax` and POST-mode OAuth callbacks (Issue #53)

The OAuth `state` cookie and session cookie both use `SameSite=Lax`. Browsers
send `Lax` cookies on top-level cross-site **GET** navigations but **not** on
cross-site **POST** requests. All three providers we support today (GitHub,
Google, Discord) use GET callbacks, so this is not an issue in the current
implementation.

If a future provider uses OpenID Connect `response_mode=form_post` (or any
other cross-site POST callback), the `Lax` cookie will not accompany the
request and CSRF state validation will fail. Two mitigations are possible at
that point:

1. **Switch the affected cookies to `SameSite=None; Secure`** — required when
   adopting a POST-mode callback. `Secure` is mandatory for `SameSite=None`;
   the `__Host-` prefix already enforces it. Note that `SameSite=None` removes
   the browser's built-in CSRF defense, so keep both CSRF checks intact:
   compare the request `state` against the state cookie, then consume the
   matching server-side KV entry (`oauth:state:*`).
2. **Continue using only GET-mode callbacks.** Document any new provider as
   GET-only at the design stage so the cookie attributes do not need to change.

This is a forward-looking note. Until a POST-mode provider is added, no code
change is required.

## API Key Format

```
UUID v4 string
Example: 00000000-0000-4000-8000-000000000000
```

- Generated via Web Crypto API: random UUID v4, matching WakaTime-compatible CLI validation
- Stored as SHA-256 hash in DB (`api_key_hash` column); plaintext shown only once
- Can be regenerated via POST /auth/api-key (old key immediately invalidated)

### API Key Transport

Three transport methods are accepted for WakaTime compatibility
(`src/utils/auth.ts`):

1. `Authorization: Basic <base64(api_key)>` — what wakatime-cli sends. Preferred.
2. `Authorization: Bearer <api_key>` — equivalent; also preferred.
3. `?api_key=<api_key>` query parameter — **compatibility fallback only.**
   Query strings are recorded in access logs, proxy logs, and browser
   history, so a key sent this way is more likely to leak. Use an
   `Authorization` header anywhere a header can be set, and rotate the key
   via `POST /auth/api-key` if it was ever pasted into a shared URL.

## Token Encryption at Rest

OAuth access_tokens and refresh_tokens are encrypted before storage:

- Algorithm: AES-256-GCM (via Web Crypto API)
- Key: `ENCRYPTION_KEY` environment secret
- IV: Random 12 bytes per encryption (stored with ciphertext)
- Format: `<base64(iv)>.<base64(ciphertext)>`

## Provider Configuration

### GitHub
- Scopes: `read:user`, `user:email`
- User info endpoint: `GET https://api.github.com/user`

### Google
- Scopes: `openid`, `email`, `profile`
- User info endpoint: `GET https://www.googleapis.com/oauth2/v2/userinfo`
- **Optional hosted domain restriction**: if `GOOGLE_HOSTED_DOMAIN` is set, the
  authorization URL includes `hd=<domain>` as a UX hint and the callback
  enforces the matching `hd` claim on the validated id_token. Tokens with no
  `hd` claim (personal Google accounts) or a non-matching `hd` are rejected
  with 403. See `specs/037-google-hosted-domain/`.

### Discord
- Scopes: `identify`, `email`
- User info endpoint: `GET https://discord.com/api/v2/users/@me`

## Environment Secrets

Set via `wrangler secret put <NAME>`:

```
GITHUB_CLIENT_ID
GITHUB_CLIENT_SECRET
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
ENCRYPTION_KEY          # 64 hex chars (256 bits), AES-256 key for token encryption
GOOGLE_HOSTED_DOMAIN    # Optional. Google Workspace primary domain to restrict logins to.
```
