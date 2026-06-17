-- Per-user embeddable-card settings (spec 160-embeddable-cards).
-- Kept in sync with src/db/schema.sql so existing D1 databases can migrate and
-- fresh deployments via `npm run db:init` get the same shape.
--
-- One row per user. An absent row means embeds are OFF (default-safe): public
-- cards return 404 unless `enabled = 1`. `freshness_minutes` drives both the
-- response Cache-Control max-age and the KV rendered-card TTL. `default_theme`
-- is a styling-only preset used when a card URL omits or gives an unknown theme.

CREATE TABLE IF NOT EXISTS embed_settings (
  user_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  freshness_minutes INTEGER NOT NULL DEFAULT 15,
  default_theme TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  modified_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
