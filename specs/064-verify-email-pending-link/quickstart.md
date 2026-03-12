# Quickstart: Verify Email Before PendingLink

**Feature**: 064-verify-email-pending-link

## Prerequisites

- Node.js and npm installed
- `wrangler` CLI configured for D1 access
- OpenAPI code generation working (`npm run generate`)

## Implementation Steps

### Step 1: Update OpenAPI Schema

Edit `schemas/openapi.yaml`:
- Add `email_verified: type: boolean` to `components.schemas.User.properties`

### Step 2: Regenerate Types

```bash
npm run generate
```

Verify `src/types/generated.ts` now includes `email_verified?: boolean` on the User type.

### Step 3: Create DB Migration

Create migration file (e.g., `migrations/001_add_email_verified.sql`):

```sql
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
UPDATE users SET email_verified = 1
WHERE id IN (SELECT DISTINCT user_id FROM oauth_accounts);
```

Apply locally:
```bash
wrangler d1 migrations apply cloudtime-db --local
```

### Step 4: Implement Callback Logic

In the OAuth callback handler, after fetching provider user info:

1. **Extract email_verified** from provider response:
   - GitHub: fetch `GET /user/emails`, find primary email, use `verified` field
   - Google: use `verified_email` field from userinfo response
   - Discord: use `verified` field from user response

2. **On new user creation**: Set `email_verified` based on provider response.

3. **On existing user login**: Update `email_verified` to match provider's latest response.

4. **On same-email detection** (multi-user mode):
   - Check `existing_user.email_verified === true`
   - Check `provider_email_verified === true`
   - If BOTH true → create PendingLink
   - If EITHER false → create new user account instead

### Step 5: Verify

Test scenarios:
1. New OAuth signup → check `email_verified` is set correctly in D1
2. OAuth login with matching email + both verified → PendingLink created
3. OAuth login with matching email + existing unverified → new account created
4. OAuth login with matching email + provider unverified → new account created
5. Single-user mode → direct linking regardless of verification status

## Key Files

| File | Change |
|------|--------|
| `schemas/openapi.yaml` | Add `email_verified` to User schema |
| `src/types/generated.ts` | Regenerated (do not hand-edit) |
| `src/db/schema.sql` | Add `email_verified` column to users table |
| `migrations/001_add_email_verified.sql` | Migration for existing databases |
| `src/routes/auth.ts` (or similar) | OAuth callback: set/update email_verified, gate PendingLink |
