# cloudtime

> [!WARNING]
> This project is under active development and is not yet ready for use. APIs may change without notice and core features are still being implemented.

A self-hosted, WakaTime-compatible coding time tracker built on Cloudflare Workers + D1.

Designed for **individual developers** who want full control over their coding metrics. Each person deploys their own instance.

## Features

- Full API compatibility with WakaTime editor plugins (90+ editors)
- OAuth login (GitHub / Google / Discord) with multi-provider linking
- Heartbeat tracking, summaries, stats, durations, goals, insights
- Runs entirely on Cloudflare's free tier (Workers + D1 + KV)
- Single-user by default, with multi-user/team mode planned

## Quick Start

### 1. Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) via this project's npm dependency
- A Cloudflare account
- OAuth app credentials for at least one provider ([GitHub](https://github.com/settings/developers) / [Google](https://console.cloud.google.com/apis/credentials) / [Discord](https://discord.com/developers/applications))

### 2. Setup

```powershell
git clone https://github.com/your-username/cloudtime.git
cd cloudtime
npm ci

# Create Cloudflare resources
npx wrangler login
npx wrangler d1 create cloudtime-db
npx wrangler kv namespace create CLOUDTIME_KV

# Public contributors: copy wrangler.toml to ignored wrangler.local.toml,
# then put the IDs from the commands above in the local copy.
Copy-Item wrangler.toml wrangler.local.toml

# In wrangler.local.toml [vars], set the public Worker URL and owner guard.
# If the workers.dev URL is not known yet, deploy once, copy the printed URL
# into APP_URL, then deploy again before opening any OAuth login URL.
# APP_URL = "https://your-cloudtime-instance.workers.dev"
# ALLOWED_OWNER_EMAIL = "you@example.com"
# PUBLIC_STATS = "false"

# Initialize the remote database when using wrangler.local.toml
npx wrangler d1 execute cloudtime-db --remote --config wrangler.local.toml --file=./src/db/schema.sql

# Set secrets
npx wrangler secret put GITHUB_CLIENT_ID --config wrangler.local.toml
npx wrangler secret put GITHUB_CLIENT_SECRET --config wrangler.local.toml
$key = node -e "process.stdout.write(crypto.randomBytes(32).toString('hex'))"
$key | npx wrangler secret put ENCRYPTION_KEY --config wrangler.local.toml
# Repeat for Google/Discord if using those providers
```

### 3. Run

```powershell
# Deploy to Cloudflare when using wrangler.local.toml
npx wrangler deploy --config wrangler.local.toml
```

### 4. Connect your editor

After your first OAuth login, generate an API key from your authenticated session. Configure your WakaTime-compatible editor plugin to point to your instance:

```ini
# ~/.wakatime.cfg
[settings]
api_url = https://your-cloudtime-instance.workers.dev/api/v1
api_key = your-uuid-api-key-here
```

## Architecture

```
Editor Plugin → Heartbeats → Cloudflare Workers (Hono)
                                    │
                              ┌─────┼─────┐
                              D1    KV    Cron
                           (SQLite) (Cache) (Aggregation)
```

## Development

This project follows **Schema Driven Development (SDD)** with automated PR review.

```bash
npm run generate   # Generate TypeScript types from OpenAPI schema
npm run dev        # Run locally
npm run deploy     # Deploy to Cloudflare
```

| Document | Description |
|----------|-------------|
| [docs/development-flow.md](docs/development-flow.md) | SDD workflow, milestones, branching strategy |
| [docs/auth-design.md](docs/auth-design.md) | OAuth, sessions, security design |
| [docs/cloudflare-constraints.md](docs/cloudflare-constraints.md) | Platform limits and mitigation strategies |
| [docs/wakatime-feature-research.md](docs/wakatime-feature-research.md) | Feature research from WakaTime |
| [schemas/openapi.yaml](schemas/openapi.yaml) | API specification (Single Source of Truth) |

## Project Structure

```
schemas/openapi.yaml         # OpenAPI 3.1 spec (SSoT)
src/
  index.ts                   # App entry point
  routes/                    # API route handlers
  types.ts                   # Cloudflare Workers bindings (Env)
  types/generated.ts         # Auto-generated from schema (do not edit)
  utils/auth.ts              # Authentication
  db/schema.sql              # Database DDL
docs/                        # Design documents
.github/
  copilot-instructions.md    # Copilot code review instructions
  instructions/              # Path-scoped review rules
```

## License

MIT

## Disclaimer

cloudtime is not affiliated with or endorsed by WakaTime. WakaTime is a trademark of WakaTime.
