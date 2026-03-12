# Authentication & Session Design

## Overview

cloudtime uses OAuth 2.0 with PKCE for user authentication. Three providers are supported:
- GitHub
- Google
- Discord

One user account can link multiple OAuth providers. Editor plugins use a permanent API key (`ck_` prefix).

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
| Editor plugins | API key (`ck_...`) via Basic Auth / Bearer | Permanent (until regenerated) |
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
4. If BOTH verified → creates PendingLink (TTL: 1 hour)
   If EITHER unverified → creates new user account instead (no PendingLink)
5. Returns pending_link with existing_username
6. User calls POST /api/v1/auth/link/approve/{pending_link_id}
7. OAuth account is linked to existing user
8. User is logged in as existing account
```

**email_verified behavior:**
- Set on user creation based on the OAuth provider's report.
- Updated on each login: uses a **high-water mark** approach — once verified (`true`), never downgraded back to `false`. Only upgrades (false → true) are applied. This follows industry best practices (Auth0, Firebase, Clerk).
- Provider-specific extraction: GitHub requires `GET /user/emails` (primary email's `verified` field), Google returns `email_verified` or `verified_email` depending on endpoint, Discord returns `verified` (absent without `email` scope, treated as `false`).

**Single-user mode:** Same-email detection still applies, but since there's only one user, the new provider is linked directly without approval. The `pending_links` table is not used. The `email_verified` field is still recorded accurately regardless of instance mode.

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

## API Key Format

```
ck_<32 random hex characters>
Example: ck_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6
```

- Generated via Web Crypto API
- Stored as SHA-256 hash in DB (`api_key_hash` column); plaintext shown only once
- Can be regenerated via POST /auth/api-key (old key immediately invalidated)

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
```
