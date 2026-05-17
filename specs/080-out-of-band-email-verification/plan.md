# Implementation Plan: Out-of-Band Email Verification for PendingLink Approval

**Branch**: `080-out-of-band-email-verification` | **Date**: 2026-05-17 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/080-out-of-band-email-verification/spec.md`

## Summary

Adds a verification-by-email layer on top of the existing PendingLink merge flow. On PendingLink creation, the server sends a one-time-token email to the recipient. Clicking the link sets `email_verified_at` on the row. The approve endpoint becomes a no-op until that field is non-null.

Email delivery is abstracted behind a single `sendEmail(...)` function with a provider selector keyed on `EMAIL_PROVIDER`. The initial PR ships only the **Resend** adapter; Cloudflare Email Service (binding-based) and AWS SES (REST + SigV4) are designed-for but deferred to follow-up PRs.

In single-user mode (default), PendingLinks are never created, so this feature is inert. The verify endpoint exists unconditionally and returns 410 Gone for tokens that resolve to no row.

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers runtime)
**Primary Dependencies**: Hono >= 4.9.7
**Storage**: D1 (new columns on `pending_links`), KV (no change)
**New external dependency**: Resend REST API (`https://api.resend.com/emails`) — called via `fetch()`, no SDK
**Testing**: Vitest + workers pool; outbound fetch mocked with `vi.spyOn(globalThis, 'fetch')`
**Target Platform**: Cloudflare Workers (edge compute)
**Project Type**: Web service (REST API)
**Performance Goals**: <2s budget for the email send; the OAuth callback waits on the send before returning
**Constraints**: D1 single-statement transactions, Workers 10ms CPU budget on free tier (the send is mostly waiting on Resend, not CPU)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | OpenAPI schema updates land in PR1 (new `/auth/link/verify/:token` path, 410 Gone response). `npm run generate` runs before implementation. |
| II. Cloudflare-Native | PASS | Resend is called via `fetch()` from Workers. No new bindings in this PR. Cloudflare Email Service binding adapter is designed for but follow-up. |
| III. Type Safety | PASS | Provider interface lives in `src/utils/email/types.ts`. Generated types absorb the new path. No hand-edits to `src/types/generated.ts`. |
| IV. Legal/Trademark | PASS | No WakaTime references. |
| V. Simplicity First | PASS | One new endpoint, one new module (`src/utils/email/`), two new columns on `pending_links`. Single adapter at this stage. |

## Project Structure

### Documentation (this feature)

```text
specs/080-out-of-band-email-verification/
├── plan.md                # This file
├── spec.md                # Feature specification
├── research.md            # Phase 0 — provider trade-offs, fail-mode choice
├── data-model.md          # Phase 1 — pending_links column additions and migration
├── quickstart.md          # Manual verification recipe
├── tasks.md               # PR1/PR2 task split
├── contracts/
│   └── openapi-diff.md    # New /auth/link/verify path + 410 response component
└── checklists/
    └── requirements.md    # Acceptance gates
```

### Source Code (repository root) — landed in PR2

```text
src/
├── types.ts                            # Add EMAIL_PROVIDER, EMAIL_FROM, RESEND_API_KEY to Env
├── utils/email/
│   ├── index.ts                        # provider selector + sendEmail() public surface
│   ├── types.ts                        # EmailMessage / EmailProvider interface
│   └── resend.ts                       # Resend adapter (POST https://api.resend.com/emails)
├── routes/auth/
│   ├── link.ts                         # On approve: enforce email_verified_at; new verify GET
│   └── login.ts                        # On PendingLink creation: generate token + send email
└── db/schema.sql                       # ALTER TABLE pending_links — two columns

migrations/
└── 0002_pending_link_email_verification.sql

schemas/paths/auth/
└── link-verify-token.yaml              # NEW path

schemas/components/responses/
└── Gone.yaml                           # NEW shared 410 component
```

**Structure Decision**: Provider adapters live in `src/utils/email/`. Two new columns extend `pending_links` rather than introducing a separate verification-tokens table — the row-token mapping is 1:1 and the existing TTL/expiry semantics on `pending_links.expires_at` already cover both lifetimes.

## Phase 0 — Research Outputs

See [research.md](./research.md). Key decisions:
1. **Resend as default adapter** — best Workers DX, free tier covers expected volume (PendingLink emails are rare events even in multi-user mode).
2. **Fail closed when provider misconfigured or send fails** — PendingLink row is not committed; OAuth callback returns 502/503. Better to refuse the merge than silently downgrade security.
3. **Verify endpoint accepts GET, single-use** — first hit consumes the token; pre-fetch by mobile clients is acceptable collateral (documented in operator runbook).
4. **Token stored as SHA-256 hash** — same pattern as session tokens and API keys.
5. **Single-user mode unaffected** — the existing PendingLink-skipping branch in `src/routes/auth/login.ts` remains the gate; the verify endpoint is unconditionally mounted but inert.

## Phase 1 — Design Outputs

### Provider interface (`src/utils/email/types.ts`)

```ts
export interface EmailMessage {
  to: string;             // single recipient
  from: string;           // env.EMAIL_FROM
  subject: string;
  html: string;
  text: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}
```

### Provider selector (`src/utils/email/index.ts`)

```ts
export function getEmailProvider(env: Env): EmailProvider | null {
  switch (env.EMAIL_PROVIDER) {
    case "resend":  return new ResendProvider(env.RESEND_API_KEY!);
    // case "cloudflare": ...  follow-up PR
    // case "ses":        ...  follow-up PR
    default:        return null;          // unconfigured ⇒ fail closed at call site
  }
}

export async function sendEmail(env: Env, msg: EmailMessage): Promise<void> {
  const provider = getEmailProvider(env);
  if (!provider) throw new EmailNotConfiguredError();
  await provider.send(msg);
}
```

### Database changes

```sql
-- migrations/0002_pending_link_email_verification.sql
ALTER TABLE pending_links ADD COLUMN email_verification_token_hash TEXT;
ALTER TABLE pending_links ADD COLUMN email_verified_at TEXT;
CREATE INDEX IF NOT EXISTS idx_pending_links_token_hash
  ON pending_links(email_verification_token_hash);
```

Existing rows have NULL in both columns. Backfill is intentionally **not** performed — pre-feature PendingLinks cannot be approved unless the user re-triggers the OAuth flow (which generates a new token). Document this in the release notes; the impact window is small since PendingLinks have a 1-hour TTL.

### OpenAPI surface change

New path `schemas/paths/auth/link-verify-token.yaml`:
- `GET /auth/link/verify/{token}` — `security: []` (public), 200/410/405 responses.

New shared response component `schemas/components/responses/Gone.yaml`.

`POST /auth/link/approve/{pending_link_id}` gains a 403 response (existing or augmented `Forbidden.yaml`).

See [contracts/openapi-diff.md](./contracts/openapi-diff.md).

## Phase 2 — Implementation Tasks

See [tasks.md](./tasks.md).

## Complexity Tracking

No constitution violations. The provider abstraction is a deliberate boundary (single function + single interface) that keeps complexity bounded.
