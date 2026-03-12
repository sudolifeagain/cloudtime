# Implementation Plan: Verify Existing User Email Before Creating PendingLink

**Branch**: `064-verify-email-pending-link` | **Date**: 2026-03-13 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/064-verify-email-pending-link/spec.md`

## Summary

Add `email_verified` field to the User data model and enforce dual email verification (existing user + incoming provider) before creating a PendingLink in multi-user mode. This is a defense-in-depth security improvement (Issue #39). The change touches four layers: OpenAPI schema, DB migration, type generation, and OAuth callback logic.

## Technical Context

**Language/Version**: TypeScript (Cloudflare Workers runtime)
**Primary Dependencies**: Hono >= 4.9.7, openapi-typescript
**Storage**: Cloudflare D1 (SQLite)
**Testing**: Manual testing via OAuth flow (no test framework configured yet)
**Target Platform**: Cloudflare Workers (edge)
**Project Type**: Web service (API)
**Performance Goals**: <10ms CPU per request (Workers free tier)
**Constraints**: D1 free tier 100K writes/day; KV 1K writes/day
**Scale/Scope**: Single-user mode default; multi-user mode future

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD (Spec Driven Development) | PASS | OpenAPI schema updated first → generate → implement |
| II. Cloudflare-Native Architecture | PASS | Single column addition; no performance impact. Simple IF check in callback. |
| III. Type Safety & Code Generation | PASS | `email_verified` added to OpenAPI User schema → `npm run generate` → use generated types |
| IV. Legal & Trademark Compliance | PASS | No WakaTime references |
| V. Simplicity First | PASS | Minimal change: 1 DB column, 1 conditional gate, 1 migration. No abstractions. |

No violations. All gates pass.

## Project Structure

### Documentation (this feature)

```text
specs/064-verify-email-pending-link/
├── plan.md              # This file
├── research.md          # Phase 0: provider email_verified research
├── data-model.md        # Phase 1: schema changes
├── contracts/           # Phase 1: OpenAPI contract changes
│   └── openapi-diff.md  # Delta description for openapi.yaml
└── quickstart.md        # Phase 1: implementation quickstart
```

### Source Code (repository root)

```text
schemas/
└── openapi.yaml              # Add email_verified to User schema

src/
├── db/
│   └── schema.sql            # Add email_verified column to users table
├── routes/
│   └── (auth callbacks)      # OAuth callback: set email_verified, gate PendingLink
├── types/
│   └── generated.ts          # Regenerated after schema change (npm run generate)
└── types.ts                  # No changes needed (Env bindings unchanged)
```

**Structure Decision**: Existing single-project structure. No new directories needed. Changes touch existing files only (schema.sql, openapi.yaml) plus the OAuth callback handler (which may be newly implemented as part of broader auth work).

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Multi-user PendingLink gating (FR-004/005/006) | Issue #39 explicitly plans this security gate. PendingLink table already exists in schema. | Single-user-only approach leaves known security gap unaddressed for future multi-user upgrades. |
