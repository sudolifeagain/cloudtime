-- Marker table for the one-off hourly_summaries backfill (Issue #142).
-- Kept in sync with src/db/schema.sql so existing D1 databases can migrate and
-- fresh deployments via `npm run db:init` get the same shape.
--
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
