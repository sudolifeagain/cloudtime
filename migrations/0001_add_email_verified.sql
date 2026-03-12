-- Add email_verified column to users table
-- O(1) operation: SQLite stores default in schema metadata, no row rewriting
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

-- Backfill: treat existing OAuth users as verified.
-- Assumption: GitHub and Google verify emails at account creation.
-- Discord without email scope may not, but this is acceptable for
-- pre-production data. Future logins will correct via high-water mark.
UPDATE users SET email_verified = 1
WHERE id IN (SELECT DISTINCT user_id FROM oauth_accounts);
