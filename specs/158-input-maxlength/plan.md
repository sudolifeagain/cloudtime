# Implementation Plan: Maximum lengths on write-input fields

**Branch**: `158-input-maxlength` | **Date**: 2026-06-10 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/158-input-maxlength/spec.md`

## Summary

Declare inclusive `maxLength`/`maxItems` on every free-text field of the four write-input schemas and enforce them in the corresponding validators: body fields reject with the endpoints' existing 400 formats; ambient header-derived values (User-Agent → 512, X-Machine-Name → 255) truncate instead. Caps are platform-invariant-sized (research R-1…R-4) so no legitimate WakaTime-compatible client can hit them. Closes the audit's storage-abuse finding (Issue #158).

**PR1 (this PR)**: SpecKit artifacts + `maxLength`/`maxItems` in `HeartbeatInput.yaml`, `CommitInput.yaml`, `ExternalDurationInput.yaml`, `CustomRuleInput.yaml` + regenerated types. **No enforcement, no behavior change.**

**PR2 (after PR1 merges)**: a shared limits module (`src/utils/input-limits.ts`) holding the cap constants + a `tooLong()` helper; enforcement wired into `validateHeartbeatInput` (`src/routes/heartbeats.ts`), `src/utils/commit-input.ts`, `src/utils/external-duration-input.ts`, `src/utils/custom-rule-input.ts`; header truncation at the two ingestion call sites; unit + integration tests.

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers)
**Primary Dependencies**: Hono >= 4.9.7
**Storage**: none — no D1/KV changes; the caps bound what future writes can store.
**Testing**: Vitest + workers pool. Unit tests per validator (boundary at cap / cap+1, dependencies forms); integration tests for the heartbeat single + bulk endpoints (per-item 400 shape preserved, header-truncation cases); existing corpus must pass unmodified (SC-002).
**Performance Goals**: <10ms CPU — length checks are O(fields) string-length comparisons on paths that already iterate the fields.
**Constraints**: spec↔validator value parity (FR-007) — enforced by defining the constants once in `src/utils/input-limits.ts` and pinning them in a parity unit test; truncation only for header-derived values (FR-004); caps inclusive (FR-003).

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | Constraints land in the OpenAPI schemas first (PR1) with regenerated types; validators follow (PR2). Additive constraint documentation — no operation/status/shape change. |
| II. Cloudflare-Native | PASS | Pure in-handler string checks; strictly less platform usage (bounded rows, bounded KV values). |
| III. Type Safety | PASS | `maxLength` does not change generated TS types (openapi-typescript emits strings regardless) — parity is held by the shared constants module + a parity unit test instead. |
| IV. Legal/Trademark | PASS | Caps derived from WakaTime's public API documentation (which documents no limits) and platform invariants; WakaTime source code not consulted (constitution constraint). |
| V. Simplicity First | PASS | One constants module, one helper, per-validator one-line checks. No generic validation framework. |

## Project Structure

### Documentation (this feature)

```text
specs/158-input-maxlength/
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
schemas/components/schemas/HeartbeatInput.yaml        # CHANGE: maxLength per field; dependencies maxItems/maxLength
schemas/components/schemas/CommitInput.yaml           # CHANGE: maxLength per field
schemas/components/schemas/ExternalDurationInput.yaml # CHANGE: maxLength per field
schemas/components/schemas/CustomRuleInput.yaml       # CHANGE: maxLength on source_value/destination_value
src/types/generated.ts                                # REGENERATED (JSDoc-only diff)

# PR2 (after PR1 merges)
src/utils/input-limits.ts                  # NEW: cap constants (single source for validators) + tooLong helper
src/routes/heartbeats.ts                   # CHANGE: length checks in validateHeartbeatInput; header-machine truncation
src/utils/user-agent.ts                    # CHANGE: truncate value to the UA cap in resolveUserAgentId
src/utils/commit-input.ts                  # CHANGE: length checks
src/utils/external-duration-input.ts       # CHANGE: length checks
src/utils/custom-rule-input.ts             # CHANGE: length checks
tests/security/input-limits.test.ts        # NEW: constants parity + helper behavior
tests/aggregation/commit-input.test.ts     # CHANGE: boundary cases
tests/aggregation/external-duration-input.test.ts  # CHANGE: boundary cases
tests/aggregation/custom-rules.test.ts     # CHANGE: boundary cases (validator part)
tests/integration/heartbeats.test.ts       # CHANGE: oversized-field 400 (single + per-item bulk), header truncation acceptance
```

**Structure Decision**: One constants module (`INPUT_LIMITS`) is the single source the four validators import, so the contract values cannot drift between validators (FR-007); a parity unit test pins the constants to the documented numbers. Validators keep their existing error-string formats — each gains "X must be at most N characters" style messages in the same voice as the current "X must be a string". Truncation happens where ambient values enter: `resolveUserAgentId` truncates its `value` argument (covering header and cache paths uniformly), and the heartbeat handlers truncate the header-sourced `machine` before `machineUpsertStmt`; body-sourced `machine`/`user_agent` are rejected earlier by the validator, so truncation never masks a body violation.

## Phases

- **PR1 — Spec + Design (this PR)**: author the SpecKit set; add the constraints to the four schemas; `npm run generate`; `npm run lint:api`; `npm run typecheck`.
- **PR2 — Implementation**: constants module + validator checks + truncation + tests; `npm test` green; PR referencing #158 and PR1.

## Risks & Mitigations

- **A legitimate client exceeds a cap** → caps sit 4–30× above realistic maxima (research R-1…R-4); boundary tests document the inclusive limit; loosening later is an additive spec change.
- **Spec/validator drift** (FR-007) → single constants module + parity test naming each documented value.
- **Bulk-shape regression** → integration tests pin the per-item heartbeat error shape and the all-or-nothing external-durations contract.
- **Truncation hides abuse via headers** → header values are capped, not trusted: truncation bounds storage exactly like rejection does; the body path (attacker-chosen by definition) still rejects.
- **openapi-typescript emits no runtime checks for maxLength** → acknowledged; enforcement is the validators' job (PR2), parity held by the constants module.
