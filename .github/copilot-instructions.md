# cloudtime

Self-hosted, WakaTime-compatible coding time tracker on Cloudflare Workers + D1.

## Architecture

- **Runtime:** Cloudflare Workers (V8 isolates, no Node.js APIs)
- **Framework:** Hono
- **Database:** Cloudflare D1 (SQLite)
- **Cache:** Cloudflare KV
- **Auth:** OAuth 2.0 (GitHub/Google/Discord) + API key for editor plugins
- **Schema:** Multi-file OpenAPI 3.1 under `schemas/` (Single Source of Truth)

## Schema-Driven Development (SDD)

The OpenAPI schema is the Single Source of Truth for all API contracts.

**Workflow:** Schema YAML → `redocly bundle` → `openapi-typescript` → `src/types/generated.ts` → implement handlers

### Multi-file schema structure

```
schemas/
├── openapi.yaml                  # Entry point (paths + security schemes)
├── paths/                        # One file per endpoint, organized by domain
│   ├── auth/                     # OAuth & session endpoints (9 files)
│   ├── heartbeats/               # Heartbeat ingestion (2 files)
│   ├── summaries/                # Summary queries (1 file)
│   ├── stats/                    # Stats, status bar, all-time, durations (4 files)
│   ├── users/                    # User profile & projects (3 files)
│   ├── goals/                    # Goals CRUD (2 files)
│   ├── leaderboards/             # Leaderboard endpoints (3 files)
│   ├── insights/                 # Insights & custom rules (3 files)
│   ├── tracking/                 # Machine names & user agents (2 files)
│   ├── external-durations/       # External time entries (2 files)
│   ├── commits/                  # Git commit tracking (2 files)
│   ├── orgs/                     # Organization management (4 files)
│   └── meta/                     # Health, editors, languages, meta (6 files)
└── components/
    ├── schemas/                  # One file per data model (38 files)
    └── responses/                # Shared error responses (2 files)
```

### SDD rules

- All path files use `$ref` to reference `components/schemas/*.yaml` for request/response bodies.
- Changes to the schema must come BEFORE implementation code.
- Run `npm run generate` after any schema change (bundles + generates types).
- `src/types/generated.ts` is auto-generated — never edit manually.
- DB schema in `src/db/schema.sql` must align with OpenAPI component schemas.
- `schemas/_bundled/` is gitignored — only the multi-file source is committed.

## Code Standards

- Use `async/await`, never raw Promise chains
- Validate all external input at route boundaries
- Return proper HTTP status codes matching the OpenAPI spec
- Use generated types from `src/types/generated.ts` for request/response typing
- Bind secrets via `Env` interface, never hardcode credentials
- Use Web Crypto API for all cryptography (no Node.js `crypto`)

## Security

- Session tokens stored as SHA-256 hash, never plaintext
- OAuth tokens encrypted with AES-256-GCM at rest
- Cookies: `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` prefix in production
- OAuth flows use PKCE + state parameter
- Never expose API keys in responses except on creation/regeneration

## Legal

- Never use "WakaTime" in code identifiers, file names, or branding
- "WakaTime-compatible" is allowed only in documentation descriptions
