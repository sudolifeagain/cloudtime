# Data Model: Verify Existing User Email Before Creating PendingLink

**Date**: 2026-03-13 | **Branch**: `064-email-verified-pendinglink`

## Schema Changes

### users table

**New column**:

| Column | Type | Default | Nullable | Description |
|--------|------|---------|----------|-------------|
| email_verified | INTEGER | 0 | NOT NULL | Account-level email verification status (0 = unverified, 1 = verified) |

**Migration SQL**:

```sql
-- Step 1: Add column with default
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

-- Step 2: Backfill from oauth_accounts
UPDATE users SET email_verified = 1
WHERE id IN (
  SELECT DISTINCT user_id FROM oauth_accounts WHERE email_verified = 1
);
```

**Validation rules**:
- Value must be 0 or 1 (enforced by application logic; SQLite has no native boolean type)
- Set to 1 when: user created via OAuth with verified email, or PendingLink approved with verified email
- Reset to 0 when: user changes email address (future feature)
- Never downgraded from 1 to 0 by provider status changes (high-water mark)

### pending_links table

No schema changes. PendingLink creation is now gated on `users.email_verified` at the application level.

### oauth_accounts table

No schema changes. Existing `email_verified` column continues to track per-provider verification status independently.

## Entity Relationships

```text
users (1) ──── (N) oauth_accounts
  │                    │
  │ email_verified     │ email_verified
  │ (account-level)    │ (provider-level)
  │                    │
  └──── (N) pending_links
              │
              │ email_verified
              │ (snapshot from provider at creation time)
```

**Key distinction**:
- `users.email_verified`: Account-level flag. Used to gate PendingLink creation.
- `oauth_accounts.email_verified`: Per-provider flag. Records what the provider reported.
- `pending_links.email_verified`: Snapshot of provider status at PendingLink creation time.

## State Transitions for users.email_verified

```text
[Account Created]
       │
       ├─ Via OAuth (verified email) ──→ email_verified = 1
       │
       └─ Via future manual registration ──→ email_verified = 0
                                                    │
                                                    ├─ Verify email (future) ──→ 1
                                                    │
                                                    └─ OAuth login matches email
                                                         │
                                                         └─ email cleared to NULL
                                                            (new user gets the email)

[PendingLink Approved]
       │
       └─ Provider email verified ──→ email_verified = 1 (if not already)
```

## Affected Queries

### login.ts — Email match (modified)

```sql
-- Before:
SELECT id FROM users WHERE email = ?

-- After:
SELECT id, email_verified FROM users WHERE email = ?
```

### login.ts — Clear unverified user's email (new)

```sql
-- Batched with new user creation for atomicity
UPDATE users SET email = NULL, modified_at = datetime('now') WHERE id = ?
```

**Security logging** (FR-008, FR-009): Log before executing the batch:
- `console.error("Security: skipping PendingLink — existing user {id} email unverified for provider {provider}")`
- `console.error("Security: clearing unverified email {email} from user {id}")`

### login.ts — New user creation (modified)

```sql
-- Existing INSERT gains email_verified column:
INSERT INTO users (id, username, email, email_verified, api_key_hash, created_at, modified_at)
VALUES (?, ?, ?, 1, ?, datetime('now'), datetime('now'))
```

**Batching note**: The email cleanup UPDATE should be prepended to the existing `db.batch()` that creates the new user + oauth_account, ensuring atomicity.

### link.ts — PendingLink approval (modified)

```sql
-- Add to existing db.batch():
UPDATE users SET email_verified = 1, modified_at = datetime('now') WHERE id = ? AND email_verified = 0
```
