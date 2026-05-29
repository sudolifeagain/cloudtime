# Operations Guide

Operator-facing runbook for running a CloudTime instance. See also
[deployment-guide.md](./deployment-guide.md) and
[backup-restore.md](./backup-restore.md).

## Heartbeat retention (`HEARTBEAT_RETENTION_DAYS`)

CloudTime stores every heartbeat as a raw row in the `heartbeats` table. The
visible UI surfaces - `/summaries`, `/stats`, `/status_bar`, `/durations`,
goals - read from the pre-aggregated `summaries` table, **not** from raw
heartbeats. Raw heartbeats are only needed by:

- `GET /heartbeats?date=...` (inspecting a specific day's raw events), and
- the hourly cron aggregator's catch-up cursor and recent-window scan.

Because of this, raw heartbeats older than your inspection window can be
discarded without affecting the aggregated rollup or any dashboard.

### Why set a retention window

Daily ingest is typically thousands of heartbeats per active user - millions
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
| `"0"`, negative, or non-numeric | Treated as unset - retain forever. |

Re-deploy (`wrangler deploy`) after changing the value.

### How it works

- The purge runs inside the existing hourly cron (`crons = ["0 * * * *"]`),
  alongside aggregation and session cleanup, and independently - a failure in
  one does not block the others.
- Each run deletes at most **1000** rows (`DELETE ... WHERE id IN (SELECT id ...
  WHERE time < cutoff LIMIT 1000)`), so a large backlog clears over several
  cron cycles rather than hammering D1 in a single run. At hourly cadence that
  is up to 24,000 rows/day of backlog clearance; once caught up, each run only
  removes the rows that aged past the window in the last hour.
- The purge is capped by the aggregation cursor (`last_aggregated_at`) minus the
  aggregator's maximum lookback window, so it only deletes rows that are safely
  behind completed cron aggregation. If aggregation has no cursor yet, or has
  fallen behind, purge skips or waits for aggregation to catch up before
  deleting that range.
- Choose a retention window comfortably larger than a day; values in the
  tens-to-hundreds of days are typical.

### Trade-offs

- **Aggregated data is preserved.** The purge only removes rows safely behind
  the aggregation cursor, so historical `/summaries` and `/stats` are
  unaffected.
- **Old raw days become unavailable.** `GET /heartbeats?date=...` for a day
  beyond the retention window returns an empty list - the raw events are gone.
- **`user_projects` first/last timestamps are unaffected.** They are maintained
  at insert time, not derived from a live heartbeat scan, so purging does not
  shift them.

### Backfill / catch-up

If you enable retention on an instance that has accumulated a large backlog,
the first purges will each remove 1000 rows per hour until the backlog is
cleared. This is intentional throttling. If aggregation has fallen behind,
purge will wait for the aggregation cursor to catch up before deleting that
range. To clear faster, first confirm `last_aggregated_at` is newer than your
retention cutoff, then run a manual bounded delete via `wrangler d1 execute`
during a maintenance window, e.g.:

```bash
wrangler d1 execute cloudtime-db --remote --command \
  "DELETE FROM heartbeats WHERE id IN (SELECT id FROM heartbeats WHERE time < unixepoch('now','-90 days') LIMIT 50000)"
```

Repeat until the row count stabilises. Always
[back up](./backup-restore.md) before bulk deletes.

## Data exports (`R2_BUCKET`)

The `/data_dumps` endpoints let a user export their own data (migration,
backup, portability). Exports are stored in R2, so the feature is **opt-in**:
it is gated on a bound `R2_BUCKET`. While unbound, the endpoints fail closed
with `503 {"error":"Data export not configured"}` — the same pattern as email
delivery.

### Enabling

Create a bucket and bind it in `wrangler.toml`, then redeploy:

```bash
wrangler r2 bucket create cloudtime-dumps
```

```toml
[[r2_buckets]]
binding = "R2_BUCKET"
bucket_name = "cloudtime-dumps"
```

### How it works

- `POST /api/v1/users/current/data_dumps` with `{"type":"daily"|"full"}`
  records a `pending` dump. A repeat request for a `type` that already has a
  `pending`/`processing` dump returns that existing dump (no duplicate).
- The **hourly cron** builds pending dumps (up to 5 per run): it serialises the
  export to JSON, uploads it to R2 (`dumps/{user_id}/{dump_id}.json`), and sets
  `status=completed`, a `download_url`, and `expires_at` (7 days out). On error
  the dump is marked `failed`.
- `GET /api/v1/users/current/data_dumps` lists the user's dumps with status;
  `download_url` (a short-lived, owner-authenticated worker route) appears once
  `completed`.
- The cron also **purges expired** dumps: it deletes the R2 object and marks
  the row `expired`; the download then returns 404.

### Export contents

- `daily` → `{ user, summaries }` (profile + per-day aggregated buckets).
- `full` → `{ user, summaries, daily, heartbeats }` (adds per-day totals and
  raw heartbeats).

Secrets (the API-key hash, OAuth tokens) are never included in an export.

### Notes

- Exports build on the cron cadence (up to ~1 hour), not instantly — they are
  for migration/backup, not interactive use.
- `email_when_finished` is accepted but only acts when email delivery is
  configured (multi-user mode).
