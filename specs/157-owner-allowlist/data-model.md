# Data Model: Optional owner allowlist for the single-user first login

**Branch**: `157-owner-allowlist` | **Date**: 2026-06-10

This feature introduces **no persisted data changes**: no new tables, no new
columns, no new KV keys, no migrations.

## Configuration (not persisted)

| Name | Where | Type | Values | Default |
|------|-------|------|--------|---------|
| `ALLOWED_OWNER_EMAIL` | Workers `[vars]` or secret binding (`Env`, `src/types.ts`, PR2) | `string \| undefined` | non-blank ⇒ gate active, matched trimmed/case-insensitively against the provider-verified email; unset/blank ⇒ gate inactive | unset ⇒ inactive |

State transitions: none at runtime — Workers vars are immutable per
deployment. The gate consults the value only during the login callback's
new-user creation branch; after the owner exists that branch is unreachable
in practice (the only-if-no-users guard closes it), so the variable becomes
inert post-bootstrap.

## Touched (unchanged) data surfaces

- **`users` (D1)**: the gate runs strictly before the bootstrap INSERT; on
  rejection no row is written. The atomic only-if-no-users guard is
  unchanged and still arbitrates concurrent allowed logins.
- **`oauth_accounts`, `pending_links`, `sessions`**: untouched — rejected
  identities reach none of them.
