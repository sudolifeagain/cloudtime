# Implementation Plan: Instance-level opt-out for the public global stats endpoint

**Branch**: `156-public-stats-optout` | **Date**: 2026-06-10 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/156-public-stats-optout/spec.md`

## Summary

Add an optional `PUBLIC_STATS` instance variable. When its trimmed, case-insensitive value is `"false"`, the unauthenticated global stats endpoint (`GET /api/v1/stats/{range}`, `getGlobalStats`) returns `404 Not Found` before touching the KV cache or D1 — for every range value, valid or not. Any other value, or unset, leaves current behavior byte-for-byte unchanged. This closes the 2026-06-10 audit finding that a single-user instance's entire coding profile is publicly readable (Issue #156).

**PR1 (this PR)**: SpecKit artifacts + OpenAPI change (document the `404` response on `getGlobalStats`, reusing the existing `NotFound` response component) + regenerated types. **No route, config, or documentation-behavior changes.**

**PR2 (after PR1 merges)**: add `PUBLIC_STATS?: string` to the manual `Env` type; add the disabled gate at the top of the handler; integration tests; operator docs (`wrangler.toml` comment + `docs/deployment-guide.md` section).

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers)
**Primary Dependencies**: Hono >= 4.9.7
**Storage**: none — no D1 schema change, no KV key change. The switch is a Workers `[vars]` binding read per request.
**Testing**: Vitest + workers pool — integration tests in `tests/integration/global-stats.test.ts` (env override per request, as `pending-link-verify.test.ts` already does with `INSTANCE_MODE`): disabled → 404 for valid and invalid ranges, no cache write; unset/`"true"`/garbage → unchanged 200/202/400; other public endpoints unaffected.
**Performance Goals**: <10ms CPU — the disabled path is a constant-time string compare returning early; the enabled path is unchanged.
**Constraints**: the disabled check MUST precede range validation, cache read/write, and all D1 access (FR-002/FR-003); response must be `404`, never `403` (FR-004).

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | OpenAPI `404` documented first (PR1); gate + tests + docs follow in PR2. Types regenerated, never hand-edited. Additive spec change only. |
| II. Cloudflare-Native | PASS | Disabled path does zero KV/D1 work — strictly less platform usage. Enabled path unchanged. `[vars]` is the idiomatic Workers configuration surface. |
| III. Type Safety | PASS | The 404 response shape comes from the shared `NotFound` component; `src/types/generated.ts` gains it via `npm run generate`. `Env.PUBLIC_STATS` lives in the manual `src/types.ts` (bindings file, PR2) like every other binding. |
| IV. Legal/Trademark | PASS | No third-party behavior consulted; the switch is CloudTime-specific and documented from our own schema. |
| V. Simplicity First | PASS | One env var, one early-return gate, one documented response. No flag framework, no runtime toggle, no falsy-alias parsing. |

## Project Structure

### Documentation (this feature)

```text
specs/156-public-stats-optout/
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
schemas/paths/meta/global-stats.yaml      # CHANGE: add '404' response ($ref NotFound) + operation prose note
src/types/generated.ts                    # REGENERATED (npm run generate)

# PR2 (after PR1 merges)
src/types.ts                              # CHANGE: add PUBLIC_STATS?: string to Env (manual bindings file)
src/routes/meta.ts                        # CHANGE: early-return 404 gate at the top of getGlobalStats
tests/integration/global-stats.test.ts    # CHANGE: disabled/enabled/garbage-value/scope cases
wrangler.toml                             # CHANGE: commented PUBLIC_STATS entry under [vars]
docs/deployment-guide.md                  # CHANGE: privacy section recommending the switch for single-user instances
```

**Structure Decision**: The gate lives inside the `getGlobalStats` handler, not in middleware and not as conditional route registration. Hono routes are registered at module scope where no `env` is available, so registration cannot depend on a binding; a dedicated middleware for one route adds indirection for a two-line check (Principle V). At the top of the handler: if `(c.env.PUBLIC_STATS ?? "").trim().toLowerCase() === "false"`, return the standard `404` error body with no-store headers — before `resolveStatsRange`, before the KV read, before any D1 query. Everything below the gate is untouched.

## Phases

- **PR1 — Spec + Design (this PR)**: author the SpecKit set; add the `404` response and prose note to `schemas/paths/meta/global-stats.yaml`; `npm run generate`; `npm run typecheck`.
- **PR2 — Implementation**: `Env.PUBLIC_STATS` + handler gate + integration tests + operator docs (`wrangler.toml`, `docs/deployment-guide.md`); `npm test` green; open PR referencing #156 and PR1.

## Risks & Mitigations

- **Operator expects falsy aliases (`0`, `no`, `off`) to work** → only `"false"` disables (fail-open default). Mitigated by documenting the exact value in `wrangler.toml` and the deployment guide (PR2), and by the explicit edge-case note in the spec.
- **Stale cached stats served after disabling** → impossible by construction: the gate precedes the cache read, so entries written while enabled are never read while disabled and expire on the existing 5-minute TTL. Covered by an integration test (PR2).
- **Probing distinguishes disabled from absent** → the gate precedes range validation, so valid and invalid ranges both yield `404`; the body reuses the standard error shape. Covered by an integration test (PR2).
- **Accidental scope creep onto other endpoints** → the gate is local to `getGlobalStats`; a scope integration test asserts `/meta`, `/editors`, `/program_languages`, `/health`, and the authenticated per-user stats are unaffected (PR2).
