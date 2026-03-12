# Implementation Plan: Timezone-Aware Summary Bucketing

**Branch**: `065-timezone-bucketing` | **Date**: 2026-03-13 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/065-timezone-bucketing/spec.md`

## Summary

Summaries are already bucketed by the user's profile timezone in the cron aggregation (`src/cron/aggregate.ts`). However, authenticated query endpoints (`/summaries`, `/stats/:range`, `/status_bar/today`, `/all_time_since_today`) default the `timezone` query parameter to UTC when omitted — causing a mismatch between stored data (bucketed by profile TZ) and query date ranges (anchored to UTC).

The primary change is **FR-009**: make authenticated endpoints default the `timezone` parameter to the user's profile timezone. Secondary work includes documenting the global stats limitation (Issue #29) and adding an OpenAPI schema update for the default behavior.

## Technical Context

**Language/Version**: TypeScript (ES2022 target, Cloudflare Workers runtime)
**Primary Dependencies**: Hono >= 4.9.7, openapi-typescript
**Storage**: Cloudflare D1 (SQLite) for summaries/heartbeats, KV for caching
**Testing**: Manual + `npx tsc --noEmit`
**Target Platform**: Cloudflare Workers (edge compute)
**Project Type**: Web service (REST API)
**Performance Goals**: 10ms CPU per request (Workers free tier)
**Constraints**: D1 batch operations, incremental cron aggregation, KV 1K writes/day (free)
**Scale/Scope**: Single-user mode (all tables have `user_id` for future multi-user)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | OpenAPI schema must be updated first (timezone parameter default description). `npm run generate` before implementation. |
| II. Cloudflare-Native | PASS | No new bindings. One additional D1 read per authenticated request to fetch user timezone (~1-2ms, well within 10ms CPU budget). |
| III. Type Safety | PASS | Route handlers already use `components["schemas"]` types. No new hand-written type aliases needed. |
| IV. Legal/Trademark | PASS | No WakaTime references. |
| V. Simplicity First | PASS | Minimal change: add a helper to resolve user TZ, thread it through 4 existing endpoints. No new abstractions. |

## Project Structure

### Documentation (this feature)

```text
specs/065-timezone-bucketing/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (OpenAPI changes)
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── cron/
│   └── aggregate.ts          # Already timezone-aware (no changes needed)
├── middleware/
│   └── auth.ts               # May need to expose user timezone in context
├── routes/
│   ├── meta.ts               # Global stats — unchanged (unauthenticated, UTC default)
│   ├── stats.ts              # FR-009: default tz to profile TZ
│   ├── summaries.ts          # FR-009: default tz to profile TZ
│   └── users.ts              # Already validates timezone (no changes needed)
├── utils/
│   └── time-format.ts        # Already has getDateForTimestamp, isValidTimezone (no changes needed)
└── types.ts                  # May need AuthEnv update if exposing userTimezone

schemas/
├── paths/
│   ├── summaries/summaries.yaml    # Update timezone param description
│   ├── stats/stats.yaml            # Update timezone param description
│   ├── stats/status-bar.yaml       # Update timezone param description
│   └── stats/durations.yaml        # Update timezone param description
│   └── meta/global-stats.yaml      # Add documentation note (FR-006)
└── components/schemas/             # No changes needed

docs/
└── timezone-behavior.md            # New: document TZ behavior (FR-006, US3)
```

**Structure Decision**: Existing single-project structure. Changes touch 4 route files, 1 middleware, and 5 OpenAPI schema files. No new directories needed.

## Complexity Tracking

No constitution violations. No complexity justification needed.
