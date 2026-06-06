# Implementation Plan: Remove API Key from OAuth Callback Response

**Branch**: `060-remove-callback-apikey` | **Date**: 2026-03-11 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/060-remove-callback-apikey/spec.md`

## Summary

Remove the `api_key` field from the OAuth callback (`GET /:provider/callback`) response to prevent credential exposure in GET responses. The API key is still generated and stored (as a hash) during account creation, but the plaintext is discarded instead of being returned. Users obtain their API key via the existing authenticated `POST /api-key` endpoint.

## Technical Context

**Language/Version**: TypeScript (Cloudflare Workers runtime)
**Primary Dependencies**: Hono >= 4.9.7, openapi-typescript
**Storage**: Cloudflare D1 (SQLite) — no schema changes needed
**Testing**: Manual endpoint testing, `npx tsc --noEmit` for type checking
**Target Platform**: Cloudflare Workers (edge compute)
**Project Type**: Web service (API)
**Performance Goals**: <10ms CPU per request (Workers free tier)
**Constraints**: No new dependencies, no database migration
**Scale/Scope**: Single-user mode, minimal change footprint

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | Spec change (remove `api_key` from callback response schema) committed before implementation. Commit order: spec → generate → implement. |
| II. Cloudflare-Native | PASS | No new D1 tables or queries. No additional CPU cost. |
| III. Type Safety | PASS | Schema change goes through `npm run generate`. Route handler uses generated types. |
| IV. Legal/Trademark | PASS | No third-party references. |
| V. Simplicity First | PASS | Removing a field — net simplification. No new abstractions. |

## Project Structure

### Documentation (this feature)

```text
specs/060-remove-callback-apikey/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── callback-response.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
schemas/
└── paths/
    └── auth/
        └── provider-callback.yaml  # Updated: remove api_key from response schema

src/
├── routes/
│   └── auth/
│       └── login.ts                # Updated: remove api_key from response object
└── types/
    └── generated.ts                # Regenerated
```

**Structure Decision**: Existing single-project structure. Two files modified (one spec, one implementation) plus regenerated types.

## Complexity Tracking

No constitution violations to justify.
