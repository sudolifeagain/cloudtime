# Implementation Plan: Verify Existing User Email Before Creating PendingLink

**Branch**: `064-email-verified-pendinglink` | **Date**: 2026-03-13 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/064-email-verified-pendinglink/spec.md`

## Summary

Add an `email_verified` column to the `users` table to track account-level email verification status. Gate PendingLink creation on the existing user having `email_verified = true`. When the existing user's email is unverified, clear their email to NULL and create a new user with the verified email instead. Backfill existing users from `oauth_accounts.email_verified`. Log security events for skipped PendingLinks and cleared emails.

## Technical Context

**Language/Version**: TypeScript (Cloudflare Workers runtime)
**Primary Dependencies**: Hono >= 4.9.7, openapi-typescript (code generation)
**Storage**: Cloudflare D1 (SQLite)
**Testing**: `npx tsc --noEmit`, manual testing against D1
**Target Platform**: Cloudflare Workers (edge)
**Project Type**: web-service
**Performance Goals**: 10ms CPU per request (Workers free tier)
**Constraints**: D1 SQLite, no Node.js APIs, Web Crypto API only
**Scale/Scope**: Single-user mode (`INSTANCE_MODE=single`)

## Security Literature Validation

Findings from internet research (see [research.md](./research.md) R0):

| Threat | Source | Our Mitigation | Status |
|--------|--------|---------------|--------|
| Classic-Federated Merge Attack | Microsoft MSRC (USENIX 2022) | PendingLink requires manual approval + email_verified gate | MITIGATED |
| Google OAuth domain takeover | Truffle Security (Jan 2025) | Primary matching uses provider_user_id (sub), not email. Email is a hint only. | MITIGATED |
| Email spoofing via OAuth | RFC 9700 (Jan 2025) | PKCE enforced, redirect URI validated, email_verified check added | MITIGATED |
| Pre-hijacking detection | Microsoft MSRC (2022) | Security event logging for skipped PendingLinks and cleared emails (FR-008, FR-009) | ADDED |

**Future consideration** (not in scope): If manual registration is added, clearing an unverified user's email should also invalidate their active sessions to prevent continued attacker access.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | OpenAPI spec update required first (new `email_verified` field on User response). Commit order: spec → generate → implement. |
| II. Cloudflare-Native | PASS | D1 migration via `ALTER TABLE ADD COLUMN`. Backfill is a single UPDATE. Email cleanup batched with user creation. |
| III. Type Safety | PASS | Generated types will include `email_verified` after spec update + `npm run generate`. |
| IV. Legal | PASS | No WakaTime references. |
| V. Simplicity First | PASS | Minimal change: one column, one conditional branch, one backfill query, two log statements. No new abstractions. |

**Post-design re-check**: All gates still PASS. Security logging (FR-008, FR-009) uses existing `console.error` — no new dependencies or abstractions.

## Project Structure

### Documentation (this feature)

```text
specs/064-email-verified-pendinglink/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
schemas/
└── openapi.yaml                    # Add email_verified to User schema

src/
├── db/
│   └── schema.sql                  # Add email_verified column to users table
├── routes/auth/
│   ├── login.ts                    # Gate PendingLink on email_verified; set on new user creation; security logging
│   └── link.ts                     # Set email_verified on PendingLink approval
├── types/
│   └── generated.ts                # Regenerated (not hand-edited)
└── utils/
    └── user.ts                     # Add email_verified to UserRow / rowToUser if needed
```

**Structure Decision**: Existing single-project structure. Changes are scoped to auth routes, schema, and the OpenAPI spec. No new files or directories needed.

## Complexity Tracking

> No constitution violations. No complexity justification needed.
