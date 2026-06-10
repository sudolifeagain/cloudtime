# Quickstart: validating the owner allowlist

**Branch**: `157-owner-allowlist` | **Scope**: PR2 behavior (PR1 ships documentation only)

## Prerequisites

- `npm install`, local D1 initialized (`npm run db:init`) with an **empty
  `users` table** (the gate only matters before bootstrap)
- A configured OAuth provider for local testing (or rely on the automated
  tests below — manual OAuth round-trips need real provider credentials)

## Scenario 1 — default: variable unset, behavior unchanged

With `ALLOWED_OWNER_EMAIL` absent from `[vars]`: first OAuth login creates
the owner exactly as today; a second identity's login returns
`403 {"error":"Registration closed. This instance only allows one user."}`.

## Scenario 2 — allowlist active: only the configured email can bootstrap

Add to `wrangler.toml` `[vars]` (or `wrangler secret put ALLOWED_OWNER_EMAIL`):

```toml
ALLOWED_OWNER_EMAIL = "owner@example.com"
```

- First login with a provider account whose **verified** email is
  `owner@example.com` (any letter case) → owner created, login completes.
- First login with any other account → `403` with the registration-closed
  body — byte-identical to Scenario 1's post-bootstrap rejection — and a
  `[owner-allowlist] rejected provider=… reason=email-mismatch
  candidate_domain=…` line in `wrangler tail`. No user row is created.

## Scenario 3 — scope: nothing else is constrained

With the variable still set and the owner bootstrapped:

- The owner's logins via already-linked providers succeed regardless of
  email.
- `POST /api/v1/auth/link/{provider}` (session required) links additional
  providers as today.
- In `INSTANCE_MODE=multi`, the variable is ignored entirely.

## Automated validation (PR2)

- `tests/security/owner-allowlist.test.ts` — pure matching rule: unset/blank
  deactivates; match (case/whitespace folded) passes; mismatch and missing
  email reject.
- `tests/integration/oauth-owner-allowlist.test.ts` (fetchMock harness,
  research D-6) — end-to-end callback: allowed email bootstraps; mismatched
  email gets the byte-identical registration-closed 403 and writes no rows.

```bash
npm run typecheck && npm test
```

Contract references: [contracts/openapi-diff.md](./contracts/openapi-diff.md)
· decisions: [research.md](./research.md) · config surface:
[data-model.md](./data-model.md)
