-- ============================================================
-- Users
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT,
  display_name TEXT,
  photo TEXT,
  bio TEXT,
  city TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  timeout INTEGER NOT NULL DEFAULT 15,
  api_key TEXT NOT NULL UNIQUE,
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
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (existing_user_id) REFERENCES users(id) ON DELETE CASCADE
);

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
