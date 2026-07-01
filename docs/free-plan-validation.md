# Workers Free Plan Validation

This checklist is for maintainers who want to verify CloudTime against the
Workers Free plan without committing personal Cloudflare account data.

## Keep account-specific configuration local

Do not paste real Cloudflare resource IDs, account IDs, OAuth client IDs, or
operator email addresses into tracked files. Keep `wrangler.toml` as the public
template and deploy test instances with an ignored local copy:

```bash
cp wrangler.toml wrangler.local.toml
```

Edit only `wrangler.local.toml` with the D1 database ID, KV namespace ID,
`APP_URL`, `ALLOWED_OWNER_EMAIL`, and any plan-test-specific Worker name.
Then pass the local config explicitly:

```bash
wrangler deploy --config wrangler.local.toml --dry-run
wrangler deploy --config wrangler.local.toml
wrangler d1 execute cloudtime-db --remote --config wrangler.local.toml --file=./src/db/schema.sql
```

Before committing, always check:

```bash
git status --short
git diff -- wrangler.toml docs README.md .github
```

The diff must not contain Cloudflare account IDs, D1 IDs, KV IDs, OAuth client
IDs, OAuth secrets, API keys, session cookies, personal email addresses, or
deployment URLs that point to a private test instance.

## Current Free plan constraints to validate

CloudTime is intended to work for a single-user instance on Workers Free. The
main constraints to validate are:

| Area | Workers Free constraint | CloudTime expectation |
|---|---:|---|
| Worker requests | 100,000 requests/day | One developer's editor heartbeats stay below this in normal use. |
| HTTP request CPU | 10 ms | Hot-path handlers avoid scans and use bounded validation. |
| Cron CPU | 10 ms | Hourly aggregation must remain incremental and bounded. |
| Subrequests | 50 per invocation | Request handlers use a small, fixed number of D1/KV calls. |
| D1 databases | 10 per account | A fresh test account can host one `cloudtime-db`. |
| D1 database size | 500 MB per database | Single-user raw heartbeat retention should be monitored or bounded. |
| D1 storage | 5 GB per account | Long-running instances should set `HEARTBEAT_RETENTION_DAYS`. |
| KV reads | 100,000/day | Auth/session/status cache reads should remain within personal-use volume. |
| KV writes | 1,000/day | Do not enable heartbeat buffering on Free; write heartbeats directly to D1. |
| Worker variables | 64 per Worker | Current bindings and secrets are below this. |
| Compressed Worker size | 3 MB | Verify with `wrangler deploy --dry-run`. |

Rate Limiting bindings are declared in `wrangler.toml`; verify they deploy on a
Free test account before claiming Free-plan compatibility for a release. If a
Free account rejects the bindings, the implementation fails open when bindings
are absent, but the production claim must be updated.

## Validation procedure

1. Use a Free-plan Cloudflare test account, not a maintainer's production
   account.
2. Create a fresh D1 database and KV namespace for the test instance.
3. Copy `wrangler.toml` to `wrangler.local.toml` and fill only the ignored local
   file with resource IDs and secrets.
4. Run `npm ci`, `npm run typecheck`, and `npm test`.
5. Run `wrangler deploy --config wrangler.local.toml --dry-run` and record the
   compressed upload size and startup time.
6. Initialize the remote schema with the local config.
7. Deploy with the local config.
8. Confirm `GET /api/v1/health` returns `200`.
9. Complete first OAuth login with `ALLOWED_OWNER_EMAIL` set.
10. Generate an API key and point a WakaTime-compatible editor plugin at the
    Worker.
11. Type in the editor for several minutes, then confirm:
    - `POST /api/v1/users/current/heartbeats` or `.heartbeats.bulk` succeeds.
    - `GET /api/v1/users/current/status_bar/today` shows time.
    - The next hourly cron creates summary rows.
    - `wrangler tail` shows no CPU-limit, subrequest-limit, D1, KV, or
      rate-limit binding errors.
12. Review Cloudflare usage dashboards for Worker requests, D1 rows read/written,
    KV reads/writes, CPU errors, and D1 storage.

## Pass criteria

The Free-plan validation passes when:

- Deployment succeeds from `wrangler.local.toml` with no tracked file changes
  containing account-specific data.
- Health, OAuth, API key generation, editor heartbeat ingestion, status bar, and
  hourly aggregation all work on the Free account.
- No handler reports CPU-limit or subrequest-limit failures during normal
  single-user use.
- Daily KV writes remain comfortably below 1,000 and D1/database storage trends
  are documented for the tested heartbeat volume.

## Cleanup

After a validation run, remove test resources from the Free account unless they
are intentionally kept for ongoing compatibility monitoring:

```bash
wrangler delete --config wrangler.local.toml
wrangler d1 delete cloudtime-db --config wrangler.local.toml
wrangler kv namespace delete --namespace-id <local-test-kv-id> --config wrangler.local.toml
```
