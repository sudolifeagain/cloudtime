<!--
Sync Impact Report
- Version change: (none) → 1.0.0 (initial ratification)
- Added principles:
  - I. Spec Driven Development (SDD)
  - II. Cloudflare-Native Architecture
  - III. Type Safety & Code Generation
  - IV. Legal & Trademark Compliance
  - V. Simplicity First
- Added sections:
  - Technology Stack
  - Development Workflow
  - Governance
- Templates requiring updates:
  - .specify/templates/plan-template.md ✅ no update needed (Constitution Check section is generic)
  - .specify/templates/spec-template.md ✅ no update needed (technology-agnostic)
  - .specify/templates/tasks-template.md ✅ no update needed (structure-agnostic)
- Follow-up TODOs: none
-->

# CloudTime Constitution

## Core Principles

### I. Spec Driven Development (SDD)

`schemas/openapi.yaml` is the **Single Source of Truth (SSoT)** for all API design,
types, validation, and documentation.

- The spec MUST be updated and committed **before** any implementation code.
- Commit order within a PR MUST be: spec change → `npm run generate` → implementation.
- Spec changes MUST receive the same review rigor as production code.
- If a review reveals a spec-level issue, it MUST be fixed in a **separate spec-first PR**;
  never patch the spec inside an implementation PR.
- `src/types/generated.ts` MUST NOT be hand-edited. It is regenerated via `npm run generate`.
- Additive spec changes (new optional fields, new endpoints) are preferred over breaking changes.
- One feature per PR keeps spec reviews focused and feedback actionable.

### II. Cloudflare-Native Architecture

CloudTime runs entirely on Cloudflare's edge platform. All design decisions
MUST respect platform limits and idioms.

- **Workers**: 10 ms CPU per request on free tier. Handlers MUST stay fast;
  offload heavy computation to Cron triggers.
- **D1 (SQLite)**: Use `db.batch()` for bulk inserts — never insert one row
  at a time in a loop. Free tier: 100K writes/day.
- **KV**: Use for caching (auth tokens, status bar). Free tier: 1K writes/day;
  avoid KV write buffer on free tier.
- **Cron aggregation**: MUST be incremental — process only new data since
  `last_aggregated_at`. Use time-windowed chunks if aggregation risks timeout.
- See `docs/cloudflare-constraints.md` for full limits and mitigation strategies.

### III. Type Safety & Code Generation

TypeScript types are generated from the OpenAPI spec. This eliminates drift
between contract and implementation.

- Route handlers MUST use types from `src/types/generated.ts`.
- Hand-written type aliases for generated types are prohibited.
- `npm run generate` MUST be run after every spec modification and its output
  committed separately from the spec change and from the implementation.

### IV. Legal & Trademark Compliance

CloudTime is an independent, MIT-licensed project. All code MUST be original.

- "WakaTime" MUST only appear as **"WakaTime-compatible"** in user-facing docs.
- "WakaTime" MUST NOT appear in code identifiers, file names, or branding.
- Never use WakaTime's logo, visual assets, or copy their documentation text.
- Never reference or read WakaTime's source code.
- All API documentation MUST be written from our own OpenAPI schema.

### V. Simplicity First

Start with the simplest approach that works. Add complexity only when
hitting actual limits — not anticipated ones.

- No premature abstractions, feature flags, or write buffers until needed.
- Avoid over-engineering: three similar lines are better than a premature helper.
- Design for single-user mode first (`INSTANCE_MODE=single`).
  Multi-user support is a future config change, not a current requirement.
- DB schema includes `user_id` on all tables to keep the upgrade path open,
  but multi-user logic MUST NOT be implemented until explicitly planned.

## Technology Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Runtime | Cloudflare Workers | Edge compute, free/paid tiers |
| Framework | Hono >= 4.9.7 | CVE-2025-58362, CVE-2025-59139 mitigated |
| Database | Cloudflare D1 (SQLite) | `db.batch()` for bulk ops |
| Cache | Cloudflare KV | Auth tokens, status bar, 1h TTL |
| Auth | OAuth 2.0 + PKCE | GitHub, Google, Discord |
| API Key | `ck_` prefix, SHA-256 hashed | Permanent until regenerated |
| Encryption | AES-256-GCM (Web Crypto) | OAuth tokens at rest |
| Types | openapi-typescript | Generated from `schemas/openapi.yaml` |
| License | MIT | |

## Development Workflow

All work follows the SDD workflow defined in `docs/development-flow.md`:

1. **Spec** — Define/update endpoint in `schemas/openapi.yaml`. Commit.
2. **Generate** — Run `npm run generate`. Commit separately.
3. **Database** — Write migration SQL if new tables needed.
4. **Implement** — Write route handler using generated types. Commit.
5. **Validate** — `npx tsc --noEmit`, test against spec contract.
6. **PR & Review** — Push feature branch, create PR targeting `develop`.

### Git Branching

- `master` is production. Only updated via `develop` merge.
- `develop` is the integration branch. All PRs MUST target `develop`.
- Feature branches: `feat/`, `fix/`, `refactor/`, `spec/`.
- All code, comments, commit messages, docs, and PR descriptions MUST be in English.

### Review Finding Triage

| Severity | Action |
|----------|--------|
| **Blocker** (security, breaking, data loss) | Fix inline before merge |
| **Medium** (missing validation, wrong status) | Fix if < 30 min; otherwise create issue |
| **Minor** (naming, style) | Create follow-up issue |
| **Spec-level** | Always a separate spec-first PR |

## Governance

- This constitution supersedes all other development practices.
  When CLAUDE.md and this constitution conflict, CLAUDE.md takes precedence
  for agent-specific rules; this constitution takes precedence for project principles.
- Amendments MUST be documented with version bump, rationale, and migration plan.
- Version follows semantic versioning:
  - **MAJOR**: Principle removal or incompatible redefinition.
  - **MINOR**: New principle or material expansion.
  - **PATCH**: Clarification, wording, or typo fix.
- All PRs and reviews MUST verify compliance with these principles.
- Complexity MUST be justified against Principle V (Simplicity First).

**Version**: 1.0.0 | **Ratified**: 2026-03-11 | **Last Amended**: 2026-03-11
