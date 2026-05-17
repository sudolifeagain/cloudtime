# Backup and Restore

This guide covers operator-managed backups of the CloudTime D1 database. Cloudflare provides account-level snapshots, but operator-driven exports remain necessary for migration, schema-change confidence, and self-managed retention.

> **Scope**: only the D1 database needs backup. KV is a cache (auth lookups, OAuth state, Google JWKS) and re-warms automatically after restore.

---

## What to back up

| Resource | Backup needed? | Why |
|---|---|---|
| `cloudtime-db` (D1) | **Yes** | Source of truth for users, heartbeats, summaries, goals, sessions, oauth_accounts, pending_links, user_agents, machine_names, … |
| `CLOUDTIME_KV` (KV) | No | Cache only. Keys: `apikey:<hash>`, `session:<hash>`, `oauth:state:<state>`, `google:jwks`. All TTL-bound and reconstructable. |
| Worker secrets | Track elsewhere | `wrangler secret put` values (OAuth client secrets, `ENCRYPTION_KEY`, `RESEND_API_KEY`). Store these in a password manager — there is no `wrangler secret get`. |
| Source code | Yes, via Git | This repo is the source; tag releases for the version actually deployed. |

### Critical: protect `ENCRYPTION_KEY`

OAuth tokens (`access_token_encrypted`, `refresh_token_encrypted`) are stored encrypted with `ENCRYPTION_KEY` using AES-256-GCM. A D1 export by itself is **useless** for restoring those tokens unless you also have the matching encryption key.

- **Losing the key** means all stored OAuth tokens become unrecoverable. Users can re-authenticate via OAuth; no data is lost beyond cached tokens.
- **Rotating the key** without re-encrypting will break decryption of existing rows.

Store the key in two places (e.g., password manager + offline backup). Never commit it to git.

---

## Backup: manual export

The simplest backup is a SQL dump:

```bash
wrangler d1 export cloudtime-db --remote --output backup-$(date +%Y%m%d-%H%M%S).sql
```

This produces a single `.sql` file containing schema + all rows. For a typical single-user deployment with a year of heartbeats, expect 50–500 MB depending on coding intensity.

### Sanity-check the dump

```bash
# Open in sqlite3 locally and confirm row counts
sqlite3 :memory: <<EOF
.read backup-20260518-090000.sql
SELECT COUNT(*) FROM heartbeats;
SELECT COUNT(*) FROM summaries;
SELECT COUNT(*) FROM users;
EOF
```

If you see your expected counts, the dump is good. Store it somewhere durable (cloud storage, encrypted external drive, etc.).

---

## Backup: scheduled / unattended

For a single-user deployment, weekly is usually enough; daily is safer if your heartbeat throughput is high.

### Option A — GitHub Actions

`.github/workflows/d1-backup.yml` example:

```yaml
name: D1 backup

on:
  schedule:
    - cron: "0 3 * * *"   # daily at 03:00 UTC
  workflow_dispatch:

jobs:
  backup:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22

      - name: Install wrangler
        run: npm install -g wrangler@latest

      - name: Export D1
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: |
          wrangler d1 export cloudtime-db --remote \
            --output backup-$(date +%Y%m%d).sql

      - name: Upload to artifact store
        uses: actions/upload-artifact@v4
        with:
          name: cloudtime-d1-${{ github.run_id }}
          path: backup-*.sql
          retention-days: 90
```

The Cloudflare API token needs `D1:Edit` permission on the account. GitHub Actions artifacts have a 90-day default retention; bump it or push to an external store (R2, S3, your own backup target) for longer keeps.

### Option B — cron on a self-managed host

If you have a VPS or home server running 24/7:

```bash
# /etc/cron.daily/cloudtime-backup
#!/bin/bash
set -euo pipefail
cd /path/to/cloudtime
wrangler d1 export cloudtime-db --remote \
  --output /var/backups/cloudtime/backup-$(date +%Y%m%d).sql
find /var/backups/cloudtime -name "backup-*.sql" -mtime +30 -delete
```

Make it executable: `chmod +x /etc/cron.daily/cloudtime-backup`. Adjust retention (`-mtime +30` keeps 30 days).

---

## Restore

Restore is **destructive** — it replaces all data in the target D1. Be intentional.

### Restoring to the same database

If you want to roll back the existing database:

```bash
# 1. WARNING: this wipes the current database
wrangler d1 execute cloudtime-db --remote --command "
  DROP TABLE IF EXISTS heartbeats;
  DROP TABLE IF EXISTS summaries;
  DROP TABLE IF EXISTS users;
  -- … list every table here, or recreate from schema.sql
"

# 2. Replay the backup
wrangler d1 execute cloudtime-db --remote --file=backup-20260518-090000.sql
```

In practice it's simpler to drop and recreate the database entirely:

```bash
wrangler d1 delete cloudtime-db
wrangler d1 create cloudtime-db          # writes a new database_id
# update wrangler.toml with the new id
wrangler d1 execute cloudtime-db --remote --file=backup-20260518-090000.sql
wrangler deploy
```

### Restoring to a fresh database

Useful for migration to a new Cloudflare account or environment:

```bash
wrangler d1 create cloudtime-db-restored
# add a new [[d1_databases]] block in wrangler.toml pointing at this DB
wrangler d1 execute cloudtime-db-restored --remote --file=backup-20260518-090000.sql

# Swap the binding name once verified, then redeploy
wrangler deploy
```

### Post-restore checklist

After restore, walk through this list before relying on the instance:

- [ ] `GET /api/v1/health` returns 200.
- [ ] `GET /api/v1/users/current` with your stored API key returns your profile (proves the row + `api_key_hash` survived).
- [ ] Send one test heartbeat; verify it appears in `SELECT * FROM heartbeats ORDER BY time DESC LIMIT 1`.
- [ ] Wait for one cron cycle (≤1 hour) and confirm `summaries` aggregation runs without errors (`wrangler tail`).
- [ ] If OAuth tokens are needed (multi-user mode): re-authenticate each linked provider account, since `ENCRYPTION_KEY` rotation would otherwise leave them undecryptable.

---

## What gets lost between backups

A backup taken at T₀ does **not** include:

- Heartbeats sent between T₀ and the failure / restore moment.
- Sessions created after T₀ (users will have to log in again — minor friction).
- Cron `last_aggregated_at` advances after T₀; the next cron run will re-aggregate the gap.

Worker secrets (`ENCRYPTION_KEY`, OAuth client secrets, `RESEND_API_KEY`) are not in the dump. Keep them in your password manager alongside the database backups.

---

## Migration to a new instance

The same export → import flow works to move CloudTime between Cloudflare accounts:

1. Export from the source: `wrangler d1 export cloudtime-db --remote --output snapshot.sql` (with the **source** wrangler login).
2. On the destination account, complete steps 1–5 of [`deployment-guide.md`](./deployment-guide.md) up to and including secrets, but use the **same `ENCRYPTION_KEY`** as the source so encrypted tokens decrypt correctly.
3. Initialise the destination D1 schema, then import: `wrangler d1 execute cloudtime-db --remote --file=snapshot.sql`.
4. Update DNS / `APP_URL` to point at the new Worker URL.
5. Re-confirm OAuth app redirect URIs match the new URL.
6. Verify with the post-restore checklist above.

If you intentionally want a fresh `ENCRYPTION_KEY` on the destination, you must accept that all stored OAuth tokens become un-decryptable. Users can re-authenticate via OAuth to repopulate them.

---

## Storage cost considerations

A 100 MB daily backup retained for 90 days = ~9 GB of artifact storage. GitHub Actions artifacts include 500 MB free; beyond that bring your own R2 / S3 / equivalent. If you prefer differential backups, run `wrangler d1 export` weekly and a delta query for incremental rows in between, but for most personal deployments full daily dumps are simpler and cheap enough.
