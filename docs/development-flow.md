# CloudTime Development Flow - Spec Driven Development (SDD)

## Overview

CloudTime adopts **Spec Driven Development (SDD)** as its core methodology. The OpenAPI specification serves as the **Single Source of Truth (SSoT)** for the entire project. All API implementations, validations, types, and documentation derive from this spec.

## Why SDD?

- **WakaTime-compatible API** - We're implementing a known, documented API. The spec captures the exact contract we must fulfill.
- **Spec before code** - No implementation until the spec is reviewed and accepted. This catches design mistakes early.
- **Type safety** - TypeScript types are generated from the spec, eliminating drift between contract and code.
- **Automated validation** - Request/response validation is derived from the spec, not hand-coded.
- **Living documentation** - The spec IS the documentation. Always in sync.

## Core Principles

1. **Spec is the source of truth** - Code serves the spec, not the other way around.
2. **Spec before code** - No implementation until the spec change is committed and validated.
3. **Specs are versioned artifacts** - `openapi.yaml` receives the same rigor as production code: peer review, branching, CI validation.
4. **Intent over implementation** - The spec captures *what* and *why*; implementation captures *how*.
5. **Drift prevention** - Tooling (linters, contract tests, type generation) enforces that code and spec stay in sync.
6. **Iterate, don't waterfall** - Spec one feature, implement, learn, update. The cycle is minutes to hours, not weeks.

## SDD Workflow (per feature)

```
┌─────────────────────────────────────────────────┐
│ 1. SPEC                                         │
│    - Create feature branch from develop          │
│    - Define/review endpoint in openapi.yaml      │
│    - Define request params, body, response       │
│    - Define error responses                      │
│    - Commit: "spec: add /endpoint"               │
├─────────────────────────────────────────────────┤
│ 2. GENERATE                                     │
│    - Run: npm run generate                       │
│    - Verify generated types match intent         │
│    - Commit: "chore: regenerate types"           │
├─────────────────────────────────────────────────┤
│ 3. DATABASE                                     │
│    - Write migration SQL if new tables needed    │
│    - Ensure DB schema aligns with API spec       │
├─────────────────────────────────────────────────┤
│ 4. IMPLEMENT                                    │
│    - Write route handler using generated types   │
│    - Write service logic                         │
│    - Commit: "feat: implement /endpoint"         │
├─────────────────────────────────────────────────┤
│ 5. VALIDATE                                     │
│    - npx tsc --noEmit (type check)               │
│    - Test endpoint against spec contract         │
│    - Verify WakaTime-compatible plugin behavior   │
│    - Check error responses match spec            │
├─────────────────────────────────────────────────┤
│ 6. PR & REVIEW                                  │
│    - Push feature branch, create PR to develop   │
│    - Copilot auto-review triggers on PR creation │
│    - Triage review findings (see below)          │
│    - Merge when review passes                    │
└─────────────────────────────────────────────────┘
```

### Commit Ordering

Within a PR, commits must follow this order. This lets reviewers see the contract change first, then verify the implementation matches.

1. **Spec change** - modifications to `schemas/openapi.yaml`
2. **Type generation** - `npm run generate` output committed separately
3. **Implementation** - route handlers, services, migrations

For pure refactoring or bug fixes that don't change the API contract, the spec commit is skipped.

## Review Finding Triage

When a reviewer (human or Copilot) identifies issues, triage by severity:

| Finding Type | Action | Rationale |
|---|---|---|
| **Blocker** (security, breaking change, data loss) | Fix inline before merge | Cannot ship |
| **Medium** (missing validation, wrong status code) | Fix inline if < 30 min; otherwise create issue | Prevents scope creep |
| **Minor** (naming, style, refactoring opportunity) | Create follow-up issue | Don't block the PR |
| **Spec-level issue** | **Always a separate issue + spec-first PR** | See below |

### When a Review Reveals a Spec Problem

This is the critical case. If a reviewer discovers that the spec itself is wrong during an implementation PR review:

1. **Do not fix the spec inside the implementation PR.** This violates spec-first and bypasses spec review.
2. **Create a new issue** documenting the spec problem. Label it `spec`.
3. **Decide on PR disposition:**
   - If the implementation is still valid with the current spec → merge, then fix spec in a follow-up PR.
   - If the spec issue makes the implementation incorrect → block the PR, fix spec first, regenerate types, then update implementation.
4. **Close the loop:** The spec-fix PR references the original review comment.

## Branching & PR Strategy

```
master (production — deploy target)
  │
  └── develop (integration — PR target)
        │
        ├── feat/heartbeat-ingestion
        ├── feat/timezone-support
        ├── refactor/extract-helper
        └── ...
```

- **`master`** is production. Only updated via `develop` merge.
- **`develop`** is the integration branch. All PRs target `develop`.
- **Feature branches** are named by type: `feat/`, `fix/`, `refactor/`, `spec/`.
- **Spec-only PRs** are allowed when a feature needs spec review before implementation.
- **One feature per PR** keeps reviews focused and feedback actionable.

## Spec Change Policy

1. **Spec changes require review** - Any modification to `openapi.yaml` is a contract change.
2. **Additive changes preferred** - Adding optional fields or new endpoints is safe.
3. **Breaking changes** - Removing fields, changing types, or altering required fields must be flagged.
4. **Regenerate after changes** - Always run `npm run generate` after spec modifications.
5. **Never hand-edit generated files** - `src/types/generated.ts` is machine-generated only.
6. **WakaTime-compatible behavior** - Spec must remain compatible with existing WakaTime-compatible editor plugins.

## Anti-Patterns

Avoid these common SDD mistakes:

1. **Code-first drift** - Writing implementation first and "updating the spec later." The spec never gets updated.
2. **Spec as decoration** - Having a spec file that nobody validates. Without CI enforcement, the spec becomes stale.
3. **Over-specifying** - Designing every possible endpoint upfront (waterfall trap). Spec one feature at a time.
4. **Hand-editing generated code** - Any manual tweak will be overwritten on the next generation run.
5. **Monolithic spec PRs** - Changing 20 endpoints in one PR. Keep spec changes focused.
6. **Fixing spec inside implementation PRs** - Breaks the spec-first invariant and bypasses spec review.

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
| OpenAPI spec | `schema.instructions.md` | operationId, required fields, $ref usage |

### Review Checklist (manual, before merge)
- [ ] Spec defines the endpoint completely
- [ ] `npm run generate` was run after any spec change
- [ ] Generated types are used in route handlers (not hand-written)
- [ ] DB migration aligns with spec models
- [ ] No secrets or tokens in error responses or logs
- [ ] Copilot review findings addressed or explicitly dismissed

## Development Phases

### Phase 0: Spec Definition (Current)

**Artifacts produced:**
- `schemas/openapi.yaml` - Complete OpenAPI 3.1 specification

### Phase 1: Code Generation & Scaffolding

**Tools:**
- `openapi-typescript` - Generate TypeScript types from OpenAPI
- Custom validation middleware derived from spec
- Hono route structure matching spec paths

### Phase 2: Implementation (per feature group)

For each feature group, follow the SDD workflow above.

### Phase 3: Validation & Testing

```
Spec
    |
    +---> Contract Tests (does implementation match spec?)
    +---> Integration Tests (do endpoints work end-to-end?)
    +---> Compatibility Tests (do WakaTime-compatible plugins work?)
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

## Key Decisions

- **OpenAPI 3.1** - Latest spec with full JSON Schema support
- **Hono framework** - Already in use; lightweight, fast, Cloudflare-native
- **D1 database** - Cloudflare's serverless SQL (SQLite-based)
- **KV for caching** - API key resolution, status bar cache
- **Cron triggers** - Hourly aggregation for summaries/stats
- **No code-first generation** - Spec is always hand-written first, code follows
