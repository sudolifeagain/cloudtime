-- Hour-of-day aggregate table for the `hours` insight (Issue #134).
-- Kept in sync with src/db/schema.sql so existing D1 databases can migrate and
-- fresh deployments via npm run db:init get the same shape.

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
