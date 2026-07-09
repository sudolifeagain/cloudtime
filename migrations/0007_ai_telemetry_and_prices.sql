-- AI token telemetry, owner-managed pricing, and the daily usage rollup
-- (Issue #200, specs/200-ai-token-cost/). Kept in sync with src/db/schema.sql
-- so existing D1 databases can migrate and fresh deployments via
-- `npm run db:init` get the same shape.
--
-- Three parts:
--   1. Nullable AI telemetry columns on `heartbeats` (ingested from compatible
--      clients; all numeric fields are non-negative integers, bounded <=1e9 at
--      the API layer). `ai_line_changes`/`human_line_changes` already exist.
--   2. `ai_model_prices`: owner-scoped, effective-dated, append-only rate rows
--      (per 1,000,000 tokens) used to estimate cost. Never a provider bill.
--   3. `ai_daily_usage`: cron-maintained daily rollup read by GET /ai/usage so
--      the request path never scans raw heartbeats (Cloudflare CPU budget).

-- 1. AI telemetry columns on heartbeats -----------------------------------
ALTER TABLE heartbeats ADD COLUMN ai_session TEXT;
ALTER TABLE heartbeats ADD COLUMN ai_subscription_plan TEXT;
ALTER TABLE heartbeats ADD COLUMN ai_prompt_length INTEGER;
ALTER TABLE heartbeats ADD COLUMN ai_input_tokens INTEGER;
ALTER TABLE heartbeats ADD COLUMN ai_output_tokens INTEGER;
ALTER TABLE heartbeats ADD COLUMN ai_cached_input_tokens INTEGER;
ALTER TABLE heartbeats ADD COLUMN ai_reasoning_output_tokens INTEGER;
ALTER TABLE heartbeats ADD COLUMN ai_cache_write_tokens INTEGER;
ALTER TABLE heartbeats ADD COLUMN ai_cache_read_tokens INTEGER;
ALTER TABLE heartbeats ADD COLUMN ai_provider TEXT;
ALTER TABLE heartbeats ADD COLUMN ai_model TEXT;

-- Bounded reads for the AI rollup cron and any category-scoped scan.
CREATE INDEX IF NOT EXISTS idx_heartbeats_user_category_time
  ON heartbeats(user_id, category, time);

-- 2. Owner-managed effective-dated pricing table --------------------------
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

-- 3. Cron-maintained daily usage rollup -----------------------------------
-- One row per (user, local day, provider, model, agent, project). The day key
-- is materialized in the owner's fixed aggregation timezone; `project` is
-- coalesced to a '' sentinel by the cron before the UPSERT so a nullable column
-- never reaches the unique conflict target (NULLs compare distinct in SQLite).
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
