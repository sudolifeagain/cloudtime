# Data Model: Server-side commit coding-time correlation

**Branch**: `145-commit-duration-correlation` | **Date**: 2026-07-10

## Storage

**No schema change in PR1.** Correlation reads existing tables and writes the existing `commits.total_seconds`. PR2 MAY add one index migration (below).

### Read: `heartbeats` (existing)

```sql
-- src/db/schema.sql (relevant columns + indexes)
CREATE TABLE IF NOT EXISTS heartbeats (
  ...
  user_id TEXT NOT NULL,
  time REAL NOT NULL,        -- Unix epoch seconds
  project TEXT,              -- nullable; commits always have a path project
  ...
);
CREATE INDEX IF NOT EXISTS idx_heartbeats_user_time ON heartbeats(user_id, time);
CREATE INDEX IF NOT EXISTS idx_heartbeats_user_project ON heartbeats(user_id, project);
```

`idx_heartbeats_user_time` serves the window range `WHERE user_id = ? AND time >= ? AND time <= ?` (upper bound inclusive, see the algorithm below). The read is **not** filtered by `project`: it fetches the full in-window user stream and reads the `project` column so each gap can be attributed to its earlier heartbeat's project (mirroring `computeDurations`, which gaps the unfiltered per-user stream and credits `[prev, curr)` to `prev.project`). No new heartbeat index is required (research D-6).

### Read: `commits` (existing) — previous-commit bound

`author_date` is stored as a normalized SQLite datetime **text** (UTC, no millis) — lexicographically sortable, so a text `<` comparison is chronological. Epoch conversion for the window uses SQLite `strftime('%s', author_date)` (avoids JS `Date.parse` ambiguity on the space-separated format).

### Read: `users` (existing) — session timeout

`SELECT timeout FROM users WHERE id = ?` (PK). Stored in minutes; multiply by 60 for the gap rule (the `getUserSettings` convention in `aggregate.ts`).

### Optional PR2 index migration

```sql
-- migrations/000X_commits_author_date_index.sql (+ mirror in src/db/schema.sql)
CREATE INDEX IF NOT EXISTS idx_commits_user_project_author_date
  ON commits(user_id, project, author_date);
```

Orders the previous-commit `SELECT MAX(author_date) … WHERE user_id = ? AND project = ? AND author_date < ?` on large commit tables. Not required for boundedness: `commits`' `UNIQUE(user_id, project, hash)` constraint already provides an auto-index whose `(user_id, project)` prefix scopes this lookup to the user+project's rows (no full scan), so this migration is a marginal optimization, cheap and unnecessary at single-user volumes — decided in PR2.

## Correlation algorithm (PR2)

Runs **only** when the validated `total_seconds` is null (client omitted it). Otherwise the value is stored verbatim and none of this executes (FR-002).

```
Inputs:  userId, project (from path), hash, authorDateText (validated; may be null), env.DB
Consts:  MAX_CORRELATION_WINDOW = 86400   # 24h, seconds
         CORRELATION_HEARTBEAT_LIMIT = 5000

1. upperText = authorDateText ?? datetime('now')          # SQLite text, UTC
   upperEpoch = strftime('%s', upperText)                 # seconds

2. prevText = SELECT MAX(author_date)
              FROM commits
              WHERE user_id = ? AND project = ? AND hash != ? AND author_date < upperText
   prevEpoch = prevText ? strftime('%s', prevText) : null  # null-author_date priors excluded

3. lowerEpoch = max(prevEpoch ?? -Infinity, upperEpoch - MAX_CORRELATION_WINDOW)

4. timeoutSec = (SELECT timeout FROM users WHERE id = ?) * 60   # minutes -> seconds

5. rows = SELECT time, project FROM heartbeats
          WHERE user_id = ? AND time >= lowerEpoch AND time <= upperEpoch
          ORDER BY time ASC
          LIMIT CORRELATION_HEARTBEAT_LIMIT
   # Upper bound is INCLUSIVE (<=): a heartbeat at exactly author_date is the
   # window's last beat, so the coding interval ending at the commit moment
   # is counted (parity with computeDurations, which counts the interval
   # ending at each heartbeat). NOT filtered by project: the full in-window
   # user stream, so gaps are attributed exactly as computeDurations
   # attributes summaries time.
   # ORDER BY time ASC + LIMIT keeps the EARLIEST rows if the cap is hit,
   # dropping the beats nearest author_date (the most recent pre-commit
   # coding) — best-effort; PR2 may read DESC then reverse to prefer them.

6. derived = 0
   for i in 1..rows.length-1:
       if rows[i-1].project === project:      # credit the gap to prev's project
           derived += sessionGapSeconds(rows[i-1].time, rows[i].time, timeoutSec)
   derived = round(derived)

7. total_seconds = derived > 0 ? derived : null
```

The upper bound is **inclusive** (`time <= upperEpoch`, step 5) so the coding interval ending at the commit moment is counted. This does **not** double-count consecutive commits: a commit's `author_date` becomes the next commit's inclusive **lower** bound (`lowerEpoch = prevEpoch`, step 3), so a heartbeat exactly on that shared boundary is the earlier commit's *last* beat (the interval ending at it counts for the earlier commit) and the later commit's *first* beat (the interval starting at it counts for the later commit) — disjoint intervals, each counted once (FR-008). When no heartbeat sits exactly on a previous-commit boundary, the interval straddling it is credited to neither — an inherent, documented consequence of partitioning (the aggregation boundaries are not shared; see the divergence note below).

`sessionGapSeconds(prev, curr, timeout)` is the shared primitive extracted from `computeDurations`:

```ts
// returns the counted seconds for one consecutive pair (0 when idle/out-of-order)
function sessionGapSeconds(prevTime: number, currTime: number, timeout: number): number {
  const gap = currTime - prevTime;
  return gap > 0 && gap <= timeout ? gap : 0;
}
```

`computeDurations` (aggregate.ts) is refactored to call this same primitive for its `gap > timeout || gap <= 0` skip, so the daily `summaries` and the per-commit derivation apply an identical **per-pair rule** (FR-005). Correlation additionally replicates `computeDurations`' **`prev.project` attribution** — it gaps the same unfiltered user stream and credits each interval to its earlier heartbeat's project (step 6) — so the two never disagree on whether a given interval counts for the project or is idle. They can still differ *numerically* because `summaries` day-bucket and round per bucket while correlation sums one previous-commit-partitioned window and rounds once; the rule and attribution are shared, the aggregation boundaries are not.

Steps 1–5 are all bounded (single-row reads + one capped-window `LIMIT` read); step 6 sums ≤ 5000 in-memory values. Total: 3 small reads + 1 upsert, within the request CPU budget (FR-007).

## Request → row mapping (PR2, changed cell only)

| Body field (`CommitInput`) | Column | Notes |
|---|---|---|
| `total_seconds` (number `>= 0` if present) | `total_seconds` | **present** → stored verbatim (client wins, FR-002). **omitted/null** → the correlation result (rounded seconds if `> 0`, else null), FR-001/FR-006. |

All other mappings are unchanged from #135 (`hash`, `message`, author/committer fields, dates, `ref`, `url`, path `project`, auth `user_id`, server `id`).

## Write path (PR2)

The upsert SQL is unchanged (#135). Only the value bound to `total_seconds` differs: the client value when present, else the correlated value. The stored row is shaped through the existing `rowToCommit` for the `201 { data: Commit }` response — a derived `> 0` value surfaces as `total_seconds` + a non-`"0 secs"` `human_readable_total`; a null (derived `0` or no heartbeats) surfaces exactly as the pre-#145 omitted case.

## Untouched

Correlation **reads** `heartbeats`, `commits`, `users` and **writes** only `commits.total_seconds` via the existing upsert. It does not modify `summaries`, `hourly_summaries`, `heartbeats`, or `user_projects` (FR-010) — commits remain an independent series. The heartbeat aggregation cron is untouched except for the behavior-preserving extraction of `sessionGapSeconds`.
