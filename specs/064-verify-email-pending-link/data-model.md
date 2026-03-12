# Data Model: Email Verification

**Feature**: 064-verify-email-pending-link
**Date**: 2026-03-13

## Entity Changes

### User (modified)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| email_verified | INTEGER (boolean) | 0 (false) | Whether the user's email has been confirmed by a trusted OAuth provider. Set/updated on each OAuth login. |

**Constraints**:
- NOT NULL — every user has a known verification state.
- Default 0 (false) — new users without OAuth are unverified.
- Updated on each successful OAuth login: upgraded to true if provider reports verified.
- High-water mark: once true, never downgraded back to false.

**Relationships**: No new relationships. The `email_verified` field is a property of the existing `users` table.

### PendingLink (unchanged)

No schema changes. The PendingLink creation logic is gated by `email_verified` checks at the application layer, not the data layer.

## Migration

### 0001_add_email_verified.sql

```sql
-- Add email_verified column to users table
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

-- Backfill: existing OAuth users are treated as verified
UPDATE users SET email_verified = 1
WHERE id IN (SELECT DISTINCT user_id FROM oauth_accounts);
```

**Rollback** (manual):
```sql
-- SQLite does not support DROP COLUMN before 3.35.0
-- D1 uses SQLite 3.45+, so DROP COLUMN is supported
ALTER TABLE users DROP COLUMN email_verified;
```

## State Transitions

```
email_verified state machine (high-water mark):

  [User Created via OAuth]
        │
        ▼
  provider reports verified?
        │
    yes ─┤── no
    │         │
    ▼         ▼
  true      false
    │         │
    │    [Next OAuth Login]
    │         │
    │         ▼
    │   provider reports verified?
    │         │
    │     yes ─┤── no
    │     │         │
    │     ▼         ▼
    │   true      false (stays false)
    │
    └──── [Next OAuth Login]
              │
              ▼
         stays true (never downgraded)
```

Key rule: **Once verified, always verified.** Only upgrades (false → true) are applied. This follows industry best practices (Auth0, Firebase, Clerk).
