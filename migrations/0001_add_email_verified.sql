-- Add email_verified column to users table
-- O(1) operation: SQLite stores default in schema metadata, no row rewriting
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

-- Backfill: existing OAuth users are treated as verified
-- (providers verified their emails at account creation time)
UPDATE users SET email_verified = 1
WHERE id IN (SELECT DISTINCT user_id FROM oauth_accounts);
