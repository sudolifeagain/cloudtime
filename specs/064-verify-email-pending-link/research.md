# Research: Email Verification from OAuth Providers

**Feature**: 064-verify-email-pending-link
**Date**: 2026-03-13

## R1: Provider Email Verification Response Fields

### Decision
Normalize each provider's email verification field to a single boolean `email_verified` on the User model. Default to `false` if the field is absent.

### Rationale
Each provider returns email verification status under a different field name. A normalization layer in the callback handler maps provider-specific responses to a consistent internal field.

### Provider Details

| Provider | User Info Endpoint | Field Name | Type | Notes |
|----------|-------------------|------------|------|-------|
| GitHub   | `GET /user/emails` (NOT `/user`) | `verified` on each email object | boolean | `/user` does NOT include verification status. Must call `/user/emails`, filter for `primary: true`, and read its `verified` field. Requires `user:email` scope. |
| Google (OIDC) | `GET openidconnect.googleapis.com/v1/userinfo` | `email_verified` | boolean | Standard OIDC claim name. |
| Google (v2) | `GET googleapis.com/oauth2/v2/userinfo` | `verified_email` | boolean | **Different field name** from OIDC endpoint. Handle both. |
| Google (ID Token) | JWT payload | `email_verified` | **string** `"true"`/`"false"` | Not a boolean in JWT — must handle string coercion. |
| Discord  | `GET discord.com/api/v10/users/@me` | `verified` | boolean (optional) | Field is **absent** (not `false`) without `email` scope. Treat `undefined` as `false`. |

### Gotchas Discovered
- **Google's `email_verified` is almost always `true`** — even Workspace accounts verified via DNS only. A `false` from Google is extremely rare but must be handled.
- **Discord's `verified` field is absent** without the `email` scope, not `false`. Code must check for `undefined`.
- **GitHub requires a second API call** (`/user/emails`) — the primary `/user` endpoint does not include verification info.

### Alternatives Considered
- **Store provider-specific field names**: Rejected. Adds unnecessary complexity. The normalization is trivial (one mapping per provider).
- **Trust all OAuth emails as verified**: Rejected. Violates issue #39's defense-in-depth requirement. Truffle Security research shows provider verified emails can be spoofed.

## R2: GitHub Email Verification — Requires Separate API Call

### Decision
For GitHub, use the `GET /user/emails` endpoint to determine the primary email's verification status. The `GET /user` response does NOT include a `verified` field.

### Rationale
GitHub's `GET /user` returns the user's public email (or `null` if no public email is set), but no verification status. The `verified` field is only available on email objects returned by `GET /user/emails`. The `user:email` scope grants access to this endpoint.

### Response Format (GitHub /user/emails)
```json
[
  {
    "email": "alice@example.com",
    "verified": true,
    "primary": true,
    "visibility": "public"
  },
  {
    "email": "alice-work@company.com",
    "verified": true,
    "primary": false,
    "visibility": null
  }
]
```

The callback handler should filter for `primary: true` AND `verified: true`. A user may have multiple emails; only the primary verified one should be used for account matching.

### Alternatives Considered
- **Only use top-level `GET /user` email**: Rejected. The top-level email may be null (if user has no public email) and does not include verification status.

## R3: Migration Strategy for Existing Users

### Decision
Use a D1 migration SQL that adds `email_verified` column with `DEFAULT 0` (false), then updates users who have at least one `oauth_account` to `email_verified = 1`.

### Rationale
- SQLite (D1) supports `ALTER TABLE ADD COLUMN` with a default value.
- Existing OAuth users had their emails verified by providers at creation time. Setting them to verified is the correct assumption.
- Users without OAuth accounts (if any exist from future manual registration) remain unverified.

### Migration SQL
```sql
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

UPDATE users SET email_verified = 1
WHERE id IN (SELECT DISTINCT user_id FROM oauth_accounts);
```

### Alternatives Considered
- **Default to `true` for all users**: Rejected. Users without OAuth accounts should not be assumed verified.
- **Separate migration file**: Not needed. D1 migrations are applied via `wrangler d1 migrations apply`. A single migration file is sufficient.

## R4: Current Implementation Status

### Finding
Route handlers are not yet implemented. The `src/routes/` directory contains only `.gitkeep`. The OAuth callback handler will need to be written as part of the broader auth implementation work. This feature's changes can either:
1. Be implemented directly if the auth routes are built first (dependency), or
2. Be designed as additions to the schema and migration now, with the callback logic added when auth routes are implemented.

### Decision
Proceed with all layers (schema, migration, and callback logic). If the callback handler doesn't exist yet, create the email_verified handling as a utility function that the future callback handler will call.
