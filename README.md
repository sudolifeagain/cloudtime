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

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- A Cloudflare account
- OAuth app credentials for at least one provider ([GitHub](https://github.com/settings/developers) / [Google](https://console.cloud.google.com/apis/credentials) / [Discord](https://discord.com/developers/applications))

### 2. Setup

```bash
git clone https://github.com/your-username/cloudtime.git
cd cloudtime
npm install

# Create Cloudflare resources
wrangler d1 create cloudtime-db
wrangler kv namespace create CLOUDTIME_KV

# Update wrangler.toml with the IDs from the commands above

# Initialize database
npm run db:init

# Set secrets
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put ENCRYPTION_KEY
# Repeat for Google/Discord if using those providers
```

### 3. Run

```bash
# Local development
npm run dev

# Deploy to Cloudflare
npm run deploy
```

### 4. Connect your editor

After your first OAuth login, you'll receive an API key (`ck_...`). Configure your editor's WakaTime plugin to point to your instance:

```ini
# ~/.wakatime.cfg
[settings]
api_url = https://your-cloudtime-instance.workers.dev/api/v1
api_key = ck_your_api_key_here
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
