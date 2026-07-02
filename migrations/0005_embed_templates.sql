-- User-defined SVG templates for public embeddable cards (spec 160).
-- Kept in sync with src/db/schema.sql so existing D1 databases can migrate and
-- fresh deployments via `npm run db:init` get the same shape.
--
-- Templates are untrusted input. Runtime validation enforces a safe static SVG
-- subset both before storage and again before public rendering.

CREATE TABLE IF NOT EXISTS embed_templates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  template_svg TEXT NOT NULL CHECK (length(template_svg) BETWEEN 1 AND 20000),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  modified_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_embed_templates_user_created
  ON embed_templates(user_id, created_at DESC);
