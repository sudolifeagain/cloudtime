# Implementation Plan: Optional Google Hosted Domain Restriction

**Branch**: `037-google-hosted-domain` | **Date**: 2026-05-17 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/037-google-hosted-domain/spec.md`

## Summary

Add an optional `GOOGLE_HOSTED_DOMAIN` environment variable. When set, the system (a) appends `hd=<domain>` to the Google authorization URL as a UX hint, and (b) — security-load-bearing — validates that the verified `id_token`'s `hd` claim matches the configured domain. On mismatch, return `403 Forbidden` and short-circuit before any DB write.

The change is fully backward-compatible: with the env var unset (the default), behavior is byte-identical to the current implementation.

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers runtime)
**Primary Dependencies**: Hono >= 4.9.7, `jose` (already in use for Google JWT verification)
**Storage**: D1 (no schema change), KV (no schema change)
**New binding**: None — `GOOGLE_HOSTED_DOMAIN` is a regular `[vars]` entry or Worker secret
**Testing**: Manual via `wrangler dev` + `tsc --noEmit`. The `hd` claim shape is well-documented and stable.
**Target Platform**: Cloudflare Workers (edge compute)
**Project Type**: Web service (REST API)
**Performance Goals**: <1ms added validation per Google callback (single string comparison)
**Constraints**: Single-domain only (multi-domain explicitly out of scope)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | OpenAPI schema updates land in PR1 (description + 403 response). `npm run generate` runs before implementation. |
| II. Cloudflare-Native | PASS | No new bindings. Uses existing `jose` JWT verification path. |
| III. Type Safety | PASS | `Env` extended via `src/types.ts`. No hand-edits to `src/types/generated.ts`. |
| IV. Legal/Trademark | PASS | No WakaTime references. |
| V. Simplicity First | PASS | ~30 LoC change in `src/utils/oauth.ts`, ~5 LoC in `src/types.ts`. No new abstractions. |

## Project Structure

### Documentation (this feature)

```text
specs/037-google-hosted-domain/
├── plan.md                # This file
├── spec.md                # Feature specification
├── research.md            # Phase 0 — hd claim, case sensitivity, threat model
├── quickstart.md          # Manual verification recipe
├── tasks.md               # PR1/PR2 task split
├── contracts/
│   └── openapi-diff.md    # 403 response + description updates
└── checklists/
    └── requirements.md    # Acceptance gates
```

### Source Code (repository root)

```text
src/
├── types.ts                       # Add GOOGLE_HOSTED_DOMAIN?: string to Env
└── utils/
    └── oauth.ts                   # Extend buildAuthorizeUrl (Google branch) and validateGoogleIdToken

wrangler.toml                      # Document optional GOOGLE_HOSTED_DOMAIN
schemas/paths/auth/
├── provider.yaml                  # Description: mention GOOGLE_HOSTED_DOMAIN
└── provider-callback.yaml         # Add 403 response for domain mismatch
```

**Structure Decision**: Touches only the Google branch of two functions in `src/utils/oauth.ts`. No new files, no new routes, no DB migration.

## Phase 0 — Research Outputs

See [research.md](./research.md). Key decisions:
1. **`hd` claim is the security gate, `hd` URL param is a hint.** Server-side verification on the signed `id_token` is the only trustworthy check.
2. **Case-insensitive comparison** using `toLowerCase()` on both sides. ASCII only — IDN domains are out of scope (no real-world Workspace IDN customers).
3. **Missing `hd` claim** (personal accounts) must fail closed when the env var is set. Workspace accounts always emit the claim; absence is signal, not error.
4. **Reject before DB writes** — the existing `validateGoogleIdToken` flow already runs before any DB write in the callback. We add the check inside that function so the rejection propagates naturally via the existing error-handling path.

## Phase 1 — Design Outputs

### Code changes

**`src/types.ts`** — extend Env:
```ts
GOOGLE_HOSTED_DOMAIN?: string;
```

**`src/utils/oauth.ts`** — two surgical edits:

1. In `buildAuthorizeUrl` (Google branch, ~line 90):
   ```ts
   if (env.GOOGLE_HOSTED_DOMAIN) url.searchParams.set("hd", env.GOOGLE_HOSTED_DOMAIN);
   ```

2. In `validateGoogleIdToken` (~line 454), after signature/iss/aud/azp/nonce/at_hash validation, before reading `sub`:
   ```ts
   const requiredHd = env.GOOGLE_HOSTED_DOMAIN?.trim().toLowerCase();
   if (requiredHd) {
     const tokenHd =
       typeof payload.hd === "string" ? payload.hd.trim().toLowerCase() : "";
     if (tokenHd !== requiredHd) {
       const reason = tokenHd ? "hd-mismatch" : "hd-missing";
       console.warn(`[google-hosted-domain] rejected rule=google-hosted-domain reason=${reason} expected=${requiredHd}`);
       throw new HostedDomainError();
     }
   }
   ```

3. Introduce `class HostedDomainError extends Error` (module-local) so the callback handler in `src/routes/auth/login.ts` can distinguish this from generic OAuth errors and emit a `403` instead of `500`. Place the `instanceof HostedDomainError` check as the first statement in the existing callback catch block, before the generic `console.error`, so hosted-domain rejections emit only the structured warning required by FR-006.

### OpenAPI diff

- `schemas/paths/auth/provider-callback.yaml` — add `'403': $ref ../../components/responses/Forbidden.yaml` (or inline body if `Forbidden.yaml` doesn't exist; will check during PR1).
- `schemas/paths/auth/provider.yaml` — add a single line in `description` referring to `GOOGLE_HOSTED_DOMAIN`.

See [contracts/openapi-diff.md](./contracts/openapi-diff.md) for exact wording.

## Phase 2 — Implementation Tasks

See [tasks.md](./tasks.md).

## Complexity Tracking

No constitution violations. No complexity justification needed.
