-- Out-of-band email verification for PendingLink approval (Issue #80).
-- Adds two nullable columns to pending_links and an index for the verify
-- endpoint lookup. Idempotent within a single instance because both column
-- adds will fail if applied twice — guard with the migration framework, not
-- with IF NOT EXISTS (which SQLite does not support on ALTER TABLE).

ALTER TABLE pending_links ADD COLUMN email_verification_token_hash TEXT;
ALTER TABLE pending_links ADD COLUMN email_verified_at TEXT;

CREATE INDEX IF NOT EXISTS idx_pending_links_token_hash
  ON pending_links(email_verification_token_hash);

-- No backfill. Pre-existing rows remain with NULL in both columns and can
-- only be approved by re-triggering the OAuth merge flow under the new
-- pipeline. PendingLink TTL is short (1 hour) so the window is bounded.
