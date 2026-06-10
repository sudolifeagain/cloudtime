# Implementation Plan: Optional owner allowlist for the single-user first login

**Branch**: `157-owner-allowlist` | **Date**: 2026-06-10 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/157-owner-allowlist/spec.md`

## Summary

Add an optional `ALLOWED_OWNER_EMAIL` instance variable. When set (non-blank) and `INSTANCE_MODE=single`, the new-user creation path of the OAuth login callback only proceeds if the identity's provider-verified email equals the configured value (trimmed, case-insensitive); every other identity — including ones with no usable verified email — receives the existing registration-closed `403`, byte-identical, with detail going to operator logs only (provider + candidate email domain). This binds the first-login bootstrap to an identity the operator controls, closing the audit's owner-race finding at the code level (Issue #157). Unset or blank = current behavior.

**PR1 (this PR)**: SpecKit artifacts + a documentation paragraph in the `oauthCallback` operation description + regenerated types (JSDoc only — the `403` status and `Forbidden` body shape are already part of the contract). **No route, config, or behavior changes.**

**PR2 (after PR1 merges)**: `Env.ALLOWED_OWNER_EMAIL`; a pure matching helper (`src/utils/owner-allowlist.ts`) unit-tested in `tests/security/`; the gate in the new-user creation path of `src/routes/auth/login.ts`; an OAuth-callback integration test using the workers-pool `fetchMock` if feasible (first such harness in the repo — fallback documented in research D-6); operator docs (`wrangler.toml` comment + deployment-guide race section update).

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers)
**Primary Dependencies**: Hono >= 4.9.7
**Storage**: none — no D1 schema change, no KV change. The variable is a Workers `[vars]`/secret binding read during the login callback only.
**Testing**: Vitest + workers pool. Unit tests for the pure helper in `tests/security/owner-allowlist.test.ts` (unset/blank passes through; match/mismatch; case+whitespace folding; null email fails closed). Integration: the callback requires mocked provider HTTP; `cloudflare:test` exposes `fetchMock` (undici MockAgent) — planned as the repo's first OAuth-callback integration test (initiate → capture state cookie + redirect → mock token/user endpoints → callback), with a documented fallback to helper-level coverage if the harness proves unstable (research D-6).
**Performance Goals**: <10ms CPU — one string comparison on the (cold) new-user path; zero work on every other path.
**Constraints**: rejection must be byte-identical to the registration-closed `403` (FR-004); full candidate address never logged (FR-005); gate must sit strictly inside the single-user new-user creation branch (FR-006).

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | Operation-description prose lands first (PR1) with regenerated types; helper, gate, tests, and docs follow in PR2. No status/shape change — additive documentation only. |
| II. Cloudflare-Native | PASS | A per-login string compare; no new storage, no new platform usage. `[vars]`/secret is the idiomatic configuration surface. |
| III. Type Safety | PASS | `Env.ALLOWED_OWNER_EMAIL` lives in the manual bindings file `src/types.ts` (PR2); generated types regenerated, never hand-edited. |
| IV. Legal/Trademark | PASS | CloudTime-specific bootstrap policy; no third-party behavior consulted. |
| V. Simplicity First | PASS | One env var, one pure helper, one early-return gate. Single address (not a list), one matching rule, no per-provider variables. |

## Project Structure

### Documentation (this feature)

```text
specs/157-owner-allowlist/
├── plan.md
├── spec.md
├── research.md
├── data-model.md
├── quickstart.md
├── tasks.md
├── contracts/
│   └── openapi-diff.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
# PR1
schemas/paths/auth/provider-callback.yaml   # CHANGE: owner-allowlist paragraph in the operation description
src/types/generated.ts                      # REGENERATED (npm run generate; JSDoc-only diff)

# PR2 (after PR1 merges)
src/types.ts                                # CHANGE: ALLOWED_OWNER_EMAIL?: string on Env (manual bindings file)
src/utils/owner-allowlist.ts                # NEW: pure helper — ownerAllowlistRejects(allowedRaw, providerEmail)
src/routes/auth/login.ts                    # CHANGE: gate in the single-user new-user creation branch
tests/security/owner-allowlist.test.ts      # NEW: unit tests for the helper
tests/integration/oauth-owner-allowlist.test.ts  # NEW (if fetchMock harness is viable): end-to-end callback cases
tests/env.d.ts                              # CHANGE: ALLOWED_OWNER_EMAIL on the test Env augmentation
wrangler.toml                               # CHANGE: commented ALLOWED_OWNER_EMAIL entry
docs/deployment-guide.md                    # CHANGE: race section gains the code-level mitigation
```

**Structure Decision**: The matching rule lives in a pure helper so the security-relevant logic is unit-testable without the OAuth harness: `ownerAllowlistRejects(allowedRaw: string | undefined, providerEmail: string | null): boolean` returns `false` when `allowedRaw` is unset/blank (gate inactive) and otherwise compares trimmed, lower-cased values, treating a null/absent email as a rejection (fail closed). The gate sits in `src/routes/auth/login.ts` immediately after `const isSingleUser = …` in the new-user creation section — after the existing email-verified gate (so `providerEmail` semantics are settled) and before any INSERT or token-encryption work. On rejection it logs `[owner-allowlist] rejected provider=… reason=… candidate_domain=…` and returns the exact registration-closed body via the existing literal. Existing-user logins return earlier in the handler and never reach the gate; the link flow is a different route; multi-user mode short-circuits on `isSingleUser`.

## Phases

- **PR1 — Spec + Design (this PR)**: author the SpecKit set; add the owner-allowlist paragraph to the `oauthCallback` description; `npm run generate`; `npm run typecheck`.
- **PR2 — Implementation**: helper + unit tests; `Env` + gate; fetchMock integration test (or documented fallback); `wrangler.toml` + deployment-guide docs; `npm test` green; PR referencing #157 and PR1.

## Risks & Mitigations

- **Operator typo locks out the bootstrap** → blank values deactivate the gate (never lock out by accident of emptiness); a typo'd address still requires only a config fix + redeploy because nothing has been claimed yet. Documented in the deployment guide (PR2).
- **Owner's provider email changes before first login** → same recovery: fix the variable, redeploy; no state involved.
- **fetchMock harness instability** (first OAuth integration test in the repo) → helper-level unit tests carry the security logic regardless; the integration test is additive coverage with a documented fallback (research D-6).
- **Accidental scope creep onto linking/existing logins** → gate placement inside the new-user branch only, plus explicit US2 scenarios verifying linked-account logins and the link flow are untouched.
- **Response divergence reveals the allowlist** → the rejection reuses the same literal as the registration-closed path; US3 test asserts byte-identical bodies.
