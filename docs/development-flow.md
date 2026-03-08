# CloudTime Development Flow - Schema Driven Development (SDD)

## Overview

CloudTime adopts **Schema Driven Development (SDD)** as its core methodology. The OpenAPI schema serves as the **Single Source of Truth (SSoT)** for the entire project. All API implementations, validations, types, and documentation derive from this schema.

## Why SDD?

- **WakaTime API compatibility** - We're implementing a known, documented API. The schema captures the exact contract we must fulfill.
- **Parallel development** - Schema defines the contract upfront; implementation and testing can proceed independently.
- **Type safety** - TypeScript types are generated from the schema, eliminating drift between spec and code.
- **Automated validation** - Request/response validation is derived from the schema, not hand-coded.
- **Living documentation** - The schema IS the documentation. Always in sync.

## Development Phases

### Phase 0: Schema Definition (Current)

```
OpenAPI Schema (schemas/openapi.yaml)
    |
    +-- Single Source of Truth for all API contracts
    +-- Defines endpoints, request/response bodies, auth, errors
    +-- Reviewed and finalized before implementation begins
```

**Artifacts produced:**
- `schemas/openapi.yaml` - Complete OpenAPI 3.1 specification
- `schemas/components/` - Reusable schema components (if needed)

### Phase 1: Code Generation & Scaffolding

```
OpenAPI Schema
    |
    +---> TypeScript Types (src/types/generated.ts)
    +---> Request Validators (src/validators/)
    +---> Route Stubs (src/routes/)
    +---> Mock Responses (for testing)
```

**Tools:**
- `openapi-typescript` - Generate TypeScript types from OpenAPI
- Custom validation middleware derived from schema
- Hono route structure matching schema paths

### Phase 2: Implementation (per feature group)

For each feature group, follow this cycle:

```
1. Verify schema defines the endpoint completely
2. Generate/update types from schema
3. Write database migration if needed (src/db/)
4. Implement route handler
5. Add request validation (schema-derived)
6. Add response validation (dev mode only)
7. Test against schema contract
```

### Phase 3: Validation & Testing

```
Schema
    |
    +---> Contract Tests (does implementation match schema?)
    +---> Integration Tests (do endpoints work end-to-end?)
    +---> Compatibility Tests (do WakaTime plugins work?)
```

## File Structure

```
cloudtime/
├── schemas/
│   └── openapi.yaml              # SSoT - OpenAPI 3.1 specification
├── docs/
│   ├── wakatime-feature-research.md  # Feature research
│   └── development-flow.md          # This document
├── src/
│   ├── db/
│   │   ├── schema.sql            # Database DDL (derived from OpenAPI models)
│   │   └── migrations/           # Incremental migrations
│   ├── types/
│   │   ├── generated.ts          # Auto-generated from OpenAPI schema
│   │   └── index.ts              # Re-exports + manual extensions
│   ├── validators/
│   │   └── index.ts              # Schema-derived request validation
│   ├── routes/
│   │   ├── heartbeats.ts         # Heartbeat endpoints
│   │   ├── summaries.ts          # Summary endpoints
│   │   ├── stats.ts              # Stats endpoints
│   │   ├── users.ts              # User endpoints
│   │   ├── durations.ts          # Duration endpoints
│   │   ├── goals.ts              # Goal endpoints
│   │   ├── leaderboards.ts       # Leaderboard endpoints
│   │   └── ...                   # Other route groups
│   ├── services/
│   │   ├── heartbeat.ts          # Heartbeat business logic
│   │   ├── aggregation.ts        # Summary/stats aggregation
│   │   └── ...                   # Other services
│   ├── utils/
│   │   └── auth.ts               # Authentication (already implemented)
│   └── index.ts                  # App entry point
├── scripts/
│   └── generate-types.ts         # Type generation from OpenAPI
├── package.json
├── tsconfig.json
└── wrangler.toml
```

## Deployment Modes

cloudtime supports two deployment modes. The DB schema and API are shared; the difference is in auth flow and which features are active.

| | Single-User (default) | Multi-User (future) |
|---|---|---|
| **Target** | Individual self-hosting | Org/team self-hosting |
| **Auth** | First OAuth login = owner, subsequent logins must match | OAuth signup open or invite-based |
| **user_id** | Always the single owner | Per-user |
| **Teams/Orgs** | Disabled | Enabled |
| **Leaderboards** | Disabled | Enabled |
| **Config** | `INSTANCE_MODE=single` (default) | `INSTANCE_MODE=multi` |

The DB always has `user_id` on every table. In single-user mode, there is exactly one row in `users`. This makes the upgrade path to multi-user a configuration change, not a migration.

## Implementation Priority

Development proceeds in feature groups, ordered by dependency and importance.
Features marked **(multi-user only)** are deferred to Milestone 4.

### Milestone 0: Auth Foundation
OAuth must work before any other feature, since all endpoints require authentication.

| # | Feature | Endpoints |
|---|---------|-----------|
| 0a | OAuth (GitHub/Google/Discord) | `GET /auth/{provider}`, `/callback` |
| 0b | Provider Linking | `POST /auth/link/{provider}`, `/callback` |
| 0c | Session Management | `GET/DELETE /auth/session`, `POST /auth/api-key` |
| 0d | Profile Management | `GET /users/current`, `PATCH /users/current/profile` |

In single-user mode, the first OAuth login creates the owner. Any subsequent OAuth login that doesn't match the owner is rejected. Linking additional providers always links to the owner (no merge approval needed).

### Milestone 1: Core (plugin compatibility)
These endpoints are required for editor plugins to function.

| # | Feature | Endpoints |
|---|---------|-----------|
| 1 | Heartbeat Ingestion | `POST /heartbeats`, `POST /heartbeats.bulk` |
| 2 | Status Bar | `GET /status_bar/today` |
| 3 | Summaries | `GET /summaries` |
| 4 | Durations | `GET /durations` |
| 5 | Stats | `GET /stats/:range` |
| 6 | All Time | `GET /all_time_since_today` |
| 7 | Projects | `GET /projects` |

### Milestone 2: Dashboard Features

| # | Feature | Endpoints |
|---|---------|-----------|
| 8 | Heartbeat Query | `GET /heartbeats`, `DELETE /heartbeats.bulk` |
| 9 | Goals | `GET /goals`, `GET /goals/:goal` |
| 10 | Insights | `GET /insights/:type/:range` |
| 11 | Custom Rules | `GET/PUT/DELETE /custom_rules` |
| 12 | Machine Names | `GET /machine_names` |
| 13 | User Agents | `GET /user_agents` |

### Milestone 3: Advanced Features

| # | Feature | Endpoints |
|---|---------|-----------|
| 14 | External Durations | CRUD for external durations |
| 15 | Commits | `GET /projects/:project/commits` |
| 16 | Data Export | `GET/POST /data_dumps` |
| 17 | Public Meta | `GET /editors`, `GET /program_languages`, `GET /meta` |
| 18 | Embeddable Charts | SVG badge generation |

### Milestone 4: Multi-User & Team (future)
Activated by `INSTANCE_MODE=multi`. DB schema already supports these; only route handlers and auth logic need to be added.

| # | Feature | Endpoints |
|---|---------|-----------|
| 19 | Multi-user signup | Open registration or invite codes |
| 20 | Leaderboards | `GET /leaders`, `GET /leaderboards` |
| 21 | Organizations | All org endpoints |
| 22 | Team Dashboards | Dashboard summaries/durations |
| 23 | Account Merge Flow | `POST /auth/link/approve/{id}` (pending_links) |
| 24 | Email Reports | Cron-based weekly/daily emails |

## SDD Workflow (per feature)

```
┌─────────────────────────────────────────────────┐
│ 1. SCHEMA                                       │
│    - Create feature branch from main             │
│    - Define/review endpoint in openapi.yaml      │
│    - Define request params, body, response       │
│    - Define error responses                      │
├─────────────────────────────────────────────────┤
│ 2. GENERATE                                     │
│    - Run type generation: npm run generate       │
│    - Verify generated types match intent         │
├─────────────────────────────────────────────────┤
│ 3. DATABASE                                     │
│    - Write migration SQL if new tables needed    │
│    - Ensure DB schema aligns with API schema     │
├─────────────────────────────────────────────────┤
│ 4. IMPLEMENT                                    │
│    - Write route handler using generated types   │
│    - Write service logic                         │
│    - Use schema-derived validation               │
├─────────────────────────────────────────────────┤
│ 5. VALIDATE                                     │
│    - Test endpoint against schema contract       │
│    - Verify WakaTime plugin compatibility        │
│    - Check error responses match schema          │
├─────────────────────────────────────────────────┤
│ 6. PR & REVIEW                                  │
│    - Push feature branch, create PR to main      │
│    - Copilot auto-review triggers on PR creation │
│    - Review checks:                              │
│      • Schema conformance                        │
│      • Security (auth, input validation, secrets)│
│      • TypeScript standards                      │
│      • SQL injection prevention                  │
│      • Error handling patterns                   │
│    - Fix Copilot findings, push updates          │
│    - Copilot re-reviews on each push             │
│    - Merge when review passes                    │
└─────────────────────────────────────────────────┘
```

## Branching & PR Strategy

```
main (protected)
  │
  ├── feat/m1-user-management
  ├── feat/m1-heartbeat-ingestion
  ├── feat/m1-status-bar
  └── ...
```

- **`main` branch** is always deployable. Direct pushes are not allowed.
- **Feature branches** are named `feat/<milestone>-<feature>` (e.g., `feat/m1-heartbeat-ingestion`).
- **Schema-only PRs** are allowed when a feature needs schema review before implementation.
- **One feature per PR** keeps reviews focused and Copilot feedback actionable.

## PR Review Process

### Automated (Copilot)
Copilot code review runs automatically on every PR and re-runs on each push. It checks against:
- `.github/copilot-instructions.md` — project-wide rules
- `.github/instructions/*.instructions.md` — path-scoped rules (TypeScript, routes, SQL, security, schema)

### What Copilot Reviews
| Scope | Instruction File | Focus |
|-------|-----------------|-------|
| All TypeScript | `typescript.instructions.md` | Strict types, no `any`, `import type`, const |
| Route handlers | `routes.instructions.md` | Auth check, validation, status codes, error handling |
| SQL files | `sql.instructions.md` | Parameterized queries, indexes, D1 limits |
| Security | `security.instructions.md` | Injection, secrets in logs, missing auth, crypto |
| OpenAPI schema | `schema.instructions.md` | operationId, required fields, $ref usage |

### Review Checklist (manual, before merge)
- [ ] Schema defines the endpoint completely
- [ ] `npm run generate` was run after any schema change
- [ ] Generated types are used in route handlers (not hand-written)
- [ ] DB migration aligns with schema models
- [ ] No secrets or tokens in error responses or logs
- [ ] Copilot review findings addressed or explicitly dismissed

## Schema Change Policy

1. **Schema changes require review** - Any modification to `openapi.yaml` is a contract change.
2. **Additive changes preferred** - Adding optional fields or new endpoints is safe.
3. **Breaking changes** - Removing fields, changing types, or altering required fields must be flagged.
4. **Regenerate after changes** - Always run `npm run generate` after schema modifications.
5. **WakaTime compatibility** - Schema must remain compatible with official WakaTime editor plugins.

## Key Decisions

- **OpenAPI 3.1** - Latest spec with full JSON Schema support
- **Hono framework** - Already in use; lightweight, fast, Cloudflare-native
- **D1 database** - Cloudflare's serverless SQL (SQLite-based)
- **KV for caching** - API key resolution, status bar cache
- **Cron triggers** - Hourly aggregation for summaries/stats
- **No code-first schema generation** - Schema is always hand-written first, code follows
