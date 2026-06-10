# OpenAPI Contract Diff: owner allowlist for the single-user first login

**Branch**: `157-owner-allowlist`
**Files**: `schemas/paths/auth/provider-callback.yaml` (operation `oauthCallback`)

This PR1 change is **documentation-only**: one paragraph added to the
operation `description`. No parameter, schema, status code, or response-shape
changes — the `403` response (`$ref` shared `Forbidden`) the gate reuses is
already part of the contract.

## 1. Operation description — document the owner allowlist

**Insertion point**: after the numbered "Security checks performed" list
item 6 ("Session fixation prevention"), as a new item 7 (keeping the list
numbering contiguous):

```
    7. **Single-user owner allowlist (optional):** when the instance variable
       `ALLOWED_OWNER_EMAIL` is set (non-blank) and the instance runs in
       single-user mode, the first-login bootstrap only accepts an identity
       whose provider-verified email equals the configured value (trimmed,
       case-insensitive; a missing verified email is rejected). Any other
       identity receives the same `403` used once registration is closed, so
       responses do not reveal whether an allowlist is configured (#157).
```

No other line in the file changes.

## Generated types impact

- `src/types/generated.ts`: JSDoc-only — the `oauthCallback` operation
  description comment gains the new paragraph. No type, parameter, or
  response member changes.
- Verified by `npm run generate` followed by reviewing the `git diff` of
  `src/types/generated.ts` (expected: description JSDoc lines only).
