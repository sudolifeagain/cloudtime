-- Git-host webhook endpoint registrations (Issue #146,
-- specs/146-git-webhook-adapter/). Kept in sync with src/db/schema.sql so
-- existing D1 databases can migrate and fresh deployments via `npm run db:init`
-- get the same shape.
--
-- One row per (provider, repo) registration: maps a git host repository to a
-- CloudTime project and stores the shared webhook secret encrypted at rest
-- (AES-256-GCM, ENCRYPTION_KEY, AAD 'webhook:<id>') — recoverable, not hashed,
-- because GitHub HMAC verification must recompute the signature from the raw
-- secret (data-model.md / research D-4). The public receiver
-- (POST /webhooks/git/{provider}) resolves the enabled registration by
-- (provider, repo) read from the delivery payload; the owner CRUD manages rows.

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,               -- 'github' | 'gitlab'
  repo TEXT NOT NULL,                   -- provider repo identity: GitHub full_name / GitLab path_with_namespace
  project TEXT NOT NULL,                -- CloudTime project the commits land under
  secret_encrypted TEXT NOT NULL,       -- AES-256-GCM (ENCRYPTION_KEY, AAD 'webhook:<id>'); never plaintext, never a hash
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  modified_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, provider, repo)
);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_user ON webhook_endpoints(user_id);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_lookup ON webhook_endpoints(provider, repo);
