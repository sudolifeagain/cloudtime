# Operations Guide

Operator-facing runbook for running a CloudTime instance. See also
[deployment-guide.md](./deployment-guide.md) and
[backup-restore.md](./backup-restore.md).

## Heartbeat retention (`HEARTBEAT_RETENTION_DAYS`)

CloudTime stores every heartbeat as a raw row in the `heartbeats` table. The
visible UI surfaces — `/summaries`, `/stats`, `/status_bar`, `/durations`,
goals — read from the pre-aggregated `summaries` table, **not** from raw
heartbeats. Raw heartbeats are only needed by:

- `GET /heartbeats?date=…` (inspecting a specific day's raw events), and
- the hourly cron aggregator's recent-window scan (last ~hour).

Because of this, raw heartbeats older than your inspection window can be
discarded without affecting the aggregated rollup or any dashboard.

### Why set a retention window

Daily ingest is typically thousands of heartbeats per active user — millions
of rows per year. Cloudflare D1 has plan-level row/size caps, so a
long-running instance will eventually need pruning.

### Configuration

Set the `HEARTBEAT_RETENTION_DAYS` variable in `wrangler.toml` under `[vars]`
(or via `wrangler secret put` if you prefer it not be committed):

```toml
[vars]
HEARTBEAT_RETENTION_DAYS = "90"
```

| Value | Behaviour |
|---|---|
| unset (default) | Retain raw heartbeats forever. No purge runs. |
| positive number (e.g. `"90"`) | Purge raw heartbeats older than N days on each hourly cron. |
| `"0"`, negative, or non-numeric | Treated as unset — retain forever. |

Re-deploy (`wrangler deploy`) after changing the value.

### How it works

- The purge runs inside the existing hourly cron (`crons = ["0 * * * *"]`),
  alongside aggregation and session cleanup, and independently — a failure in
  one does not block the others.
- Each run deletes at most **1000** rows (`DELETE … WHERE id IN (SELECT id …
  WHERE time < cutoff LIMIT 1000)`), so a large backlog clears over several
  cron cycles rather than hammering D1 in a single run. At hourly cadence that
  is up to 24,000 rows/day of backlog clearance; once caught up, each run only
  removes the rows that aged past the window in the last hour.
- The cutoff (`now − N days`) is always far older than the aggregator's
  lookback window (minutes), so the purge never removes data the recent-window
  aggregation still needs. Choose a retention window comfortably larger than a
  day; values in the tens-to-hundreds of days are typical.

### Trade-offs

- **Aggregated data is preserved.** `summaries` are computed before a heartbeat
  could ever be purged, so historical `/summaries` and `/stats` are unaffected.
- **Old raw days become unavailable.** `GET /heartbeats?date=…` for a day
  beyond the retention window returns an empty list — the raw events are gone.
- **`user_projects` first/last timestamps are unaffected.** They are maintained
  at insert time, not derived from a live heartbeat scan, so purging does not
  shift them.

### Backfill / catch-up

If you enable retention on an instance that has accumulated a large backlog,
the first purges will each remove 1000 rows per hour until the backlog is
cleared. This is intentional throttling. To clear faster, you can run a manual
bounded delete via `wrangler d1 execute` during a maintenance window, e.g.:

```bash
wrangler d1 execute cloudtime-db --remote --command \
  "DELETE FROM heartbeats WHERE id IN (SELECT id FROM heartbeats WHERE time < unixepoch('now','-90 days') LIMIT 50000)"
```

Repeat until the row count stabilises. Always
[back up](./backup-restore.md) before bulk deletes.
