-- ============================================================
-- Users
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE COLLATE NOCASE,
  display_name TEXT,
  photo TEXT,
  bio TEXT,
  city TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  timeout INTEGER NOT NULL DEFAULT 15,
  api_key_hash TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  is_hireable INTEGER NOT NULL DEFAULT 0,
  github_username TEXT,
  twitter_username TEXT,
  website TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  modified_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- ============================================================
-- OAuth Accounts (multiple providers per user)
-- ============================================================
CREATE TABLE IF NOT EXISTS oauth_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  provider_username TEXT,
  provider_email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_user ON oauth_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_oauth_provider ON oauth_accounts(provider, provider_user_id);

-- ============================================================
-- Sessions (web sessions, not for editor plugins)
-- ============================================================
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  ip TEXT,
  country TEXT,
  city TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- ============================================================
-- Pending Account Links (for merge approval flow)
-- ============================================================
CREATE TABLE IF NOT EXISTS pending_links (
  id TEXT PRIMARY KEY,
  existing_user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  provider_username TEXT,
  provider_email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  -- Out-of-band email verification (Issue #80). Populated at PendingLink
  -- creation when running in multi-user mode with an email provider configured.
  email_verification_token_hash TEXT,
  email_verified_at TEXT,
  FOREIGN KEY (existing_user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(existing_user_id, provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_pending_links_expires ON pending_links(expires_at);
CREATE INDEX IF NOT EXISTS idx_pending_links_token_hash
  ON pending_links(email_verification_token_hash);

-- ============================================================
-- Heartbeats (core tracking data)
-- ============================================================
CREATE TABLE IF NOT EXISTS heartbeats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'file',
  category TEXT DEFAULT 'coding',
  time REAL NOT NULL,
  project TEXT,
  project_root_count INTEGER,
  branch TEXT,
  language TEXT,
  dependencies TEXT,
  lines INTEGER,
  ai_line_changes INTEGER,
  human_line_changes INTEGER,
  -- AI coding telemetry (Issue #200). All nullable; numeric fields are
  -- non-negative integers bounded <=1e9 at the API layer.
  ai_session TEXT,
  ai_subscription_plan TEXT,
  ai_prompt_length INTEGER,
  ai_input_tokens INTEGER,
  ai_output_tokens INTEGER,
  ai_cached_input_tokens INTEGER,
  ai_reasoning_output_tokens INTEGER,
  ai_cache_write_tokens INTEGER,
  ai_cache_read_tokens INTEGER,
  ai_provider TEXT,
  ai_model TEXT,
  lineno INTEGER,
  cursorpos INTEGER,
  is_write INTEGER NOT NULL DEFAULT 0,
  editor TEXT,
  operating_system TEXT,
  machine TEXT,
  user_agent_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_heartbeats_user_time ON heartbeats(user_id, time);
CREATE INDEX IF NOT EXISTS idx_heartbeats_user_project ON heartbeats(user_id, project);
CREATE INDEX IF NOT EXISTS idx_heartbeats_user_date ON heartbeats(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_heartbeats_time ON heartbeats(time);
-- Bounded reads for the AI usage rollup cron and category-scoped scans (#200).
CREATE INDEX IF NOT EXISTS idx_heartbeats_user_category_time
  ON heartbeats(user_id, category, time);

-- ============================================================
-- Summaries (daily aggregated, populated by cron)
-- ============================================================
CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  project TEXT,
  language TEXT,
  editor TEXT,
  operating_system TEXT,
  category TEXT,
  branch TEXT,
  machine TEXT,
  entity TEXT,
  total_seconds REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_unique
  ON summaries(user_id, date, project, language, editor, operating_system, category, branch, machine);

-- ============================================================
-- Hourly Summaries (hour-of-day aggregated, populated by cron)
-- Backs the `hours`-of-day insight (Issue #134). Maintained by the same hourly
-- cron pass as `summaries`, off the same last_aggregated_at cursor. One row per
-- (user, local date, local hour 0-23); total_seconds accumulates via UPSERT.
-- ============================================================
CREATE TABLE IF NOT EXISTS hourly_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  hour INTEGER NOT NULL CHECK (hour >= 0 AND hour <= 23),
  total_seconds REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hourly_summaries_unique
  ON hourly_summaries(user_id, date, hour);

-- Marker table for the one-off hourly_summaries backfill (Issue #142).
-- A user/date present here was created by the backfill and may be safely
-- continued by later chunks. Dates that already existed in hourly_summaries
-- without this marker are skipped to avoid double-counting cron-populated rows.
CREATE TABLE IF NOT EXISTS hourly_backfill_dates (
  user_id TEXT NOT NULL,
  date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, date),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================================================
-- Goals
-- ============================================================
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'coding',
  delta TEXT NOT NULL DEFAULT 'day',
  target_seconds REAL NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  is_snoozed INTEGER NOT NULL DEFAULT 0,
  is_inverse INTEGER NOT NULL DEFAULT 0,
  languages TEXT,
  editors TEXT,
  projects TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  modified_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);

-- ============================================================
-- Leaderboards
-- ============================================================
CREATE TABLE IF NOT EXISTS leaderboards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  modified_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS leaderboard_members (
  leaderboard_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (leaderboard_id, user_id),
  FOREIGN KEY (leaderboard_id) REFERENCES leaderboards(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================================================
-- Custom Rules
-- ============================================================
CREATE TABLE IF NOT EXISTS custom_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'change',
  source TEXT NOT NULL,
  operation TEXT NOT NULL,
  source_value TEXT NOT NULL,
  destination TEXT NOT NULL,
  destination_value TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_custom_rules_user ON custom_rules(user_id);

-- ============================================================
-- Machine Names
-- ============================================================
CREATE TABLE IF NOT EXISTS machine_names (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  value TEXT NOT NULL,
  ip TEXT,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, value)
);

-- ============================================================
-- User Agents (editor plugins)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_agents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  value TEXT NOT NULL,
  editor TEXT,
  version TEXT,
  os TEXT,
  is_browser_extension INTEGER NOT NULL DEFAULT 0,
  is_desktop_app INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, value)
);

-- ============================================================
-- External Durations (calendar integrations etc.)
-- ============================================================
CREATE TABLE IF NOT EXISTS external_durations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'app',
  category TEXT,
  start_time REAL NOT NULL,
  end_time REAL NOT NULL,
  project TEXT,
  branch TEXT,
  language TEXT,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_ext_durations_user_time ON external_durations(user_id, start_time);

-- ============================================================
-- Commits
-- ============================================================
CREATE TABLE IF NOT EXISTS commits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project TEXT NOT NULL,
  hash TEXT NOT NULL,
  message TEXT,
  author_name TEXT,
  author_email TEXT,
  author_date TEXT,
  committer_name TEXT,
  committer_email TEXT,
  committer_date TEXT,
  total_seconds REAL,
  ref TEXT,
  url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, project, hash)
);

-- ============================================================
-- Organizations
-- ============================================================
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timeout INTEGER NOT NULL DEFAULT 15,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  writes_only INTEGER NOT NULL DEFAULT 0,
  default_project_privacy TEXT NOT NULL DEFAULT 'visible',
  is_duration_visible INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS org_members (
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  is_view_only INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS org_dashboards (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_viewing_restricted INTEGER NOT NULL DEFAULT 0,
  is_manual_time_hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- ============================================================
-- Data Dumps
-- ============================================================
CREATE TABLE IF NOT EXISTS data_dumps (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'daily',
  status TEXT NOT NULL DEFAULT 'pending',
  download_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ============================================================
-- User Projects (pre-aggregated, updated on heartbeat ingestion)
-- ============================================================
CREATE TABLE IF NOT EXISTS user_projects (
  user_id TEXT NOT NULL,
  project TEXT NOT NULL,
  first_heartbeat_at REAL NOT NULL,
  last_heartbeat_at REAL NOT NULL,
  PRIMARY KEY (user_id, project),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_projects_last_hb
  ON user_projects(user_id, last_heartbeat_at);

-- Key-value store for internal state (e.g., last_aggregated_at)
-- SQLite note: INSERT OR REPLACE deletes then inserts (triggers ON DELETE).
-- Use INSERT ... ON CONFLICT (key) DO UPDATE SET value = excluded.value instead.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ============================================================
-- Embed Settings (per-user embeddable stat cards, spec 160)
-- One row per user. An absent row means embeds are OFF (default-safe):
-- public cards return 404 unless `enabled = 1`. `freshness_minutes` drives
-- both the response Cache-Control max-age and the KV rendered-card TTL.
-- `default_theme` is a styling-only preset used when a card URL omits or
-- gives an unknown theme.
-- ============================================================
CREATE TABLE IF NOT EXISTS embed_settings (
  user_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  freshness_minutes INTEGER NOT NULL DEFAULT 15 CHECK (freshness_minutes BETWEEN 1 AND 1440),
  default_theme TEXT NOT NULL DEFAULT 'default' CHECK (length(default_theme) BETWEEN 1 AND 32),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  modified_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- User-defined SVG templates for public embeddable cards (spec 160).
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

-- ============================================================
-- AI Model Prices (owner-managed, effective-dated; Issue #200)
-- Append-only rate rows (per 1,000,000 tokens in `currency`). Supersede a rate
-- by inserting a new row or setting `effective_to`, never by rewriting history.
-- Rows are always user-scoped; shipped starter defaults are seeded per user
-- with is_default=1 (read-only via the owner endpoints), so every price lookup
-- stays a plain WHERE user_id = ? with no global/nullable-user_id special case.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_model_prices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  input_cost_per_mtok REAL,
  cached_input_cost_per_mtok REAL,
  output_cost_per_mtok REAL,
  reasoning_output_cost_per_mtok REAL,
  cache_write_cost_per_mtok REAL,
  cache_read_cost_per_mtok REAL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  source_url TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ai_model_prices_user ON ai_model_prices(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_model_prices_lookup
  ON ai_model_prices(user_id, provider, model, effective_from);

-- ============================================================
-- AI Daily Usage (cron-maintained rollup; Issue #200)
-- One row per (user, local day, provider, model, agent, project), summed from
-- contributing `ai coding` heartbeats by src/cron/aggregate.ts off the same
-- last_aggregated_at watermark as `summaries`. GET /ai/usage reads this rollup
-- (aggregate-then-price) so the request path never scans raw heartbeats. The
-- `day` key is materialized in the owner's fixed aggregation timezone; nullable
-- source dimensions (currently only `project`) are coalesced to a '' sentinel
-- before the UPSERT so a NULL never reaches the unique conflict target (SQLite
-- compares NULLs distinct, which would defeat the ON CONFLICT dedup).
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_daily_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  agent TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  prompt_length_total INTEGER NOT NULL DEFAULT 0,
  prompt_length_count INTEGER NOT NULL DEFAULT 0,
  heartbeat_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_daily_usage_unique
  ON ai_daily_usage(user_id, day, provider, model, agent, project);
CREATE INDEX IF NOT EXISTS idx_ai_daily_usage_user_day
  ON ai_daily_usage(user_id, day);
