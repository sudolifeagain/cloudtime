# Deployment Guide

This guide walks an operator through deploying CloudTime to Cloudflare Workers
from a local checkout. "Local" here means this PC is the deployment
workstation; the application itself runs on Cloudflare Workers, D1, and KV.
It assumes you have a Cloudflare account and Node.js 22+ on the workstation.

> **Critical**: read the [First-login owner race](#critical-first-login-owner-race) section before you announce or share the deployment URL. The instance becomes "owned" by whoever completes OAuth login first.

---

## 1. Prerequisites

- Cloudflare account (free plan is sufficient for personal use)
- Wrangler via this project's npm dependency (`npx wrangler ...`)
- Node.js 22+
- A registered OAuth app on at least one provider (GitHub / Google / Discord) configured with a redirect URI matching your future Worker URL
- For multi-user mode: a Resend API key and a verified sender domain (see [`email-setup.md`](./email-setup.md))

## 2. Clone and install

```powershell
git clone https://github.com/sudolifeagain/cloudtime.git
cd cloudtime
npm ci
```

Authenticate this workstation with Cloudflare:

```powershell
npx wrangler login
npx wrangler whoami
```

## 3. Provision Cloudflare resources

Create the D1 database and KV namespace.

```powershell
npx wrangler d1 create cloudtime-db

npx wrangler kv namespace create CLOUDTIME_KV
```

If this checkout is used for public development, do not paste account-specific
IDs into tracked files. Copy the template to an ignored local config and edit
only that copy:

```powershell
Copy-Item wrangler.toml wrangler.local.toml
# → copy the D1 database_id and KV id into wrangler.local.toml
```

For a private deployment-only checkout, editing `wrangler.toml` directly is
also acceptable. Public contributors should prefer `wrangler.local.toml`.

## 4. Configure deployment variables

Set deployment-specific variables in the ignored `wrangler.local.toml` copy,
not in tracked `wrangler.toml`.

At minimum, set these under `[vars]`:

```toml
APP_URL = "https://your-cloudtime-instance.workers.dev"
ALLOWED_OWNER_EMAIL = "you@example.com"
PUBLIC_STATS = "false"
```

`APP_URL` must match the public Worker origin that OAuth providers redirect
back to. `ALLOWED_OWNER_EMAIL` should be set before the first public deploy so
only your provider-verified email can claim the single-user instance.
`PUBLIC_STATS = "false"` is recommended for private single-user deployments.

If the final `workers.dev` URL is not known yet, deploy once after configuring
resources and secrets, copy the printed URL into `APP_URL`, then deploy again
before opening any OAuth login URL.

## 5. Initialise the schema

The schema lives in `src/db/schema.sql`. Run it against your new D1.

```powershell
npx wrangler d1 execute cloudtime-db --remote --config wrangler.local.toml --file=./src/db/schema.sql
```

If you redeploy later and there are migration files in `migrations/`, apply them in order:

```powershell
npx wrangler d1 execute cloudtime-db --remote --config wrangler.local.toml --file=./migrations/0001_add_email_verified.sql
npx wrangler d1 execute cloudtime-db --remote --config wrangler.local.toml --file=./migrations/0002_pending_link_email_verification.sql
```

## 6. Configure secrets

Set these via `wrangler secret put <NAME>` (each command will prompt for the value). All are required unless marked optional.
When using an ignored local config, pass `--config wrangler.local.toml` to each
`wrangler secret put` command.

| Secret | Required | Notes |
|---|---|---|
| `GITHUB_CLIENT_ID` | for GitHub login | from your GitHub OAuth App |
| `GITHUB_CLIENT_SECRET` | for GitHub login | |
| `GOOGLE_CLIENT_ID` | for Google login | from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | for Google login | |
| `DISCORD_CLIENT_ID` | for Discord login | from Discord Developer Portal |
| `DISCORD_CLIENT_SECRET` | for Discord login | |
| `ENCRYPTION_KEY` | **yes** | 64 hex characters (256 bits). Generate with the Node command below. |
| `GOOGLE_HOSTED_DOMAIN` | optional | Restricts Google login to one Workspace domain. See `specs/037-google-hosted-domain/`. |
| `EMAIL_PROVIDER` | multi-user only | `resend` is currently the only supported value. |
| `EMAIL_FROM` | multi-user only | Sender address on a domain you control. |
| `RESEND_API_KEY` | multi-user only | From your Resend dashboard. |

You only need OAuth secrets for the providers you actually plan to enable; users can sign in with any provider that has credentials configured.

Generate and store `ENCRYPTION_KEY` from the workstation without printing it:

```powershell
$key = node -e "process.stdout.write(crypto.randomBytes(32).toString('hex'))"
$key | npx wrangler secret put ENCRYPTION_KEY --config wrangler.local.toml
```

Set at least one OAuth provider before the first login. For example, for GitHub:

```powershell
npx wrangler secret put GITHUB_CLIENT_ID --config wrangler.local.toml
npx wrangler secret put GITHUB_CLIENT_SECRET --config wrangler.local.toml
```

Configure the provider callback URL to match `APP_URL`, for example:

```text
https://your-cloudtime-instance.workers.dev/api/v1/auth/github/callback
```

The web dashboard uses the same callback URL.

## 7. Choose instance mode

CloudTime defaults to **single-user mode** (`INSTANCE_MODE=single` in `wrangler.toml`). This is the right choice if:

- You're hosting it just for yourself
- You don't want anyone else to be able to register

In single-user mode the first OAuth login becomes the owner; all subsequent OAuth logins for previously-unknown `(provider, provider_user_id)` pairs are rejected with `403 Registration closed`.

For multi-user mode, set `INSTANCE_MODE=multi` in `wrangler.toml` `[vars]` and additionally configure the email provider (see [`email-setup.md`](./email-setup.md)).

### Privacy: public global stats (`PUBLIC_STATS`)

`GET /api/v1/stats/{range}` is unauthenticated and serves an instance-wide
activity aggregate. On a single-user instance that aggregate is your entire
coding profile — total time, daily average, language/editor/OS breakdowns —
readable by anyone who knows your Worker URL.

To disable the endpoint, add to `wrangler.toml` `[vars]`:

```toml
PUBLIC_STATS = "false"
```

A disabled instance answers `404` to every request on that path — the
response does not reveal that the endpoint exists — and performs no cache or
database work for it. Only the literal value `false` (trimmed,
case-insensitive) disables; unset or any other value leaves the endpoint
enabled, which is the backward-compatible default.

**Recommended for single-user instances** unless you intentionally want a
public activity profile. The setting takes effect on the next
`npx wrangler deploy --config wrangler.local.toml`.

## 8. Deploy

```powershell
npm run deploy -- --config wrangler.local.toml
```

The npm script builds `public/assets/app.css` before running Wrangler. The Worker URL will be printed (something like `https://cloudtime.<your-subdomain>.workers.dev`). Add a custom domain via the Cloudflare dashboard if you want a stable URL.

## 9. Verify the deployment

```bash
curl -i https://your-worker.example.com/api/v1/health
# Expect: HTTP/2 200, body: {"status":"ok"}

curl -I https://your-worker.example.com/assets/app.css
# Expect: HTTP/2 200
```

Open `https://your-worker.example.com/app` in a browser. If the health check and CSS asset both return 200, the Worker and web UI assets are reachable. **Do not announce the URL yet**; complete the first-login owner claim below before sharing it.

---

## Critical: First-login owner race

CloudTime's single-user mode uses the atomic SQL:

```sql
INSERT INTO users (id, username, …)
SELECT ?, ?, …
WHERE (SELECT COUNT(*) FROM users) = 0
```

Whoever completes OAuth login first becomes the permanent owner. The race window is **from the moment your Worker URL is reachable until you complete OAuth login from your own browser**.

### Code-level mitigation: `ALLOWED_OWNER_EMAIL` (recommended)

Set the owner identity **before** the Worker is first reachable and the race
disappears: only an OAuth identity whose provider-verified email matches can
claim the instance.

```toml
[vars]
ALLOWED_OWNER_EMAIL = "you@example.com"
```

- Matching is trimmed and case-insensitive; the email must be **verified** at
  the provider (GitHub primary verified email, Google, or Discord).
- Everyone else receives the same `403 Registration closed` response the
  instance returns once bootstrapped, so probes cannot tell an allowlist
  exists. Rejections appear in `npx wrangler tail --config wrangler.local.toml` as `[owner-allowlist]
  rejected …` with the candidate's email domain only.
- A typo cannot lock you out permanently: nothing has been claimed yet, so
  fix the value and redeploy. An unset or blank value disables the gate.
- The variable gates only the first-login bootstrap; it does not constrain
  the owner's later logins or provider linking.

The procedure below remains the universal baseline — and the only mitigation
on instances that do not set the variable.

### What you must do

1. **Do not share the Worker URL** in public channels, README files, status pages, or DM screenshots until step 2 is complete.
2. **Immediately log in yourself** via an OAuth provider whose credentials you control:
   - Open `https://your-worker.example.com/app` in a private browser tab.
   - Click the configured provider.
   - Complete the OAuth flow.
   - Confirm the dashboard loads under `/app`.
3. **Generate your API key** from the dashboard. The plaintext UUID API key is shown **once**. Store it in your password manager and your `~/.wakatime.cfg`.

For automation, the API route remains available:

   ```bash
   curl -X POST \
     -H "Cookie: __Host-session=<your session token>" \
     -H "Origin: https://your-worker.example.com" \
     https://your-worker.example.com/api/v1/auth/api-key
   ```

### Why this matters

If a third party who knows or guesses your Worker URL completes OAuth login first:

- They become the owner. Their `user_id` is in the `users` table.
- Subsequent attempts (including yours) are rejected with `403 Registration closed`.
- The OAuth `oauth_accounts` row points to *their* provider account, not yours.

Cloudflare Workers default URLs (`*.workers.dev`) are technically enumerable by determined attackers; the practical risk for a hobbyist host is low, but the recovery cost is high enough that the "log in immediately yourself" discipline is worth following.

### Re-bootstrap recovery (destructive)

If the race is lost, the only way back is to wipe the `users` table:

```bash
npx wrangler d1 execute cloudtime-db --remote --config wrangler.local.toml \
  --command "DELETE FROM users;"
```

`ON DELETE CASCADE` removes all child rows (sessions, oauth_accounts, heartbeats, summaries, goals, user_agents, …). You'll have a completely empty instance again. **Do this only if you intentionally want to discard all data on the instance.** After deletion, re-run step 2 above to register yourself.

If you want to keep accumulated heartbeats but kick out an unintended owner, contact the heartbeat data owner (you) and decide whether you trust the existing data; selectively re-attributing rows is operationally hard and not officially supported.

---

## 10. Configure your WakaTime-compatible editor plugin

Point your editor's WakaTime-compatible plugin at your Worker. In `~/.wakatime.cfg`:

```ini
[settings]
api_url = https://your-worker.example.com/api/v1
api_key = <your UUID API key from step 3 above>
```

Restart your editor. Your IDE's status bar should start showing today's coding time within a few seconds of typing.

---

## 11. Ongoing operations

- **Backups**: see [`backup-restore.md`](./backup-restore.md). Schedule periodic D1 exports — the Cloudflare account-level snapshots are not a substitute for operator-owned exports.
- **Heartbeat retention** (when [Issue #108](https://github.com/sudolifeagain/cloudtime/issues/108) ships): consider setting `HEARTBEAT_RETENTION_DAYS` to bound table growth.
- **Email deliverability**: if you've enabled multi-user mode, monitor Resend's bounce / complaint rate and the `[email]` log lines.
- **Rate-limit metrics**: monitor `[rate-limit]` warnings in `npx wrangler tail --config wrangler.local.toml` to detect abuse. Tune the `[[ratelimits]]` blocks in `wrangler.toml` if legitimate traffic gets rejected.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `403 Registration closed` on your own first OAuth login | Someone else completed login first. See "Re-bootstrap recovery". |
| `400 OAuth authorization failed` | Provider's OAuth app redirect URI does not match `APP_URL`/`<worker URL>/api/v1/auth/<provider>/callback`. Update the OAuth app config. |
| `/app` is unstyled or `/assets/app.css` is 404 | Deploy with `npm run deploy -- --config wrangler.local.toml` so Tailwind CSS + daisyUI assets are built and uploaded. |
| `429 Too many requests` on OAuth | Rate limiter rejected your client IP. Wait 60 seconds; if recurring, widen the limit in `wrangler.toml`. |
| Heartbeat 500 errors | Check `npx wrangler tail --config wrangler.local.toml` — usually D1 connectivity or a schema mismatch (re-run the remote schema command in step 5). |
| `GET /heartbeats` returns the wrong day's data | Set your timezone via `PATCH /api/v1/users/current/profile` (`{"timezone": "Asia/Tokyo"}`). The endpoint defaults to your profile timezone since PR #112. |
| Status bar in IDE shows 0 minutes | Confirm your `api_url` is exactly `<worker>/api/v1` (no trailing slash, no `/heartbeats`). |
