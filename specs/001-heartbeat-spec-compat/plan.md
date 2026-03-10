# Implementation Plan: Heartbeat Spec WakaTime-CLI Compatibility

**Branch**: `001-heartbeat-spec-compat` | **Date**: 2026-03-11 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-heartbeat-spec-compat/spec.md`

## Summary

Update the heartbeat OpenAPI spec and route handlers to achieve full wakatime-cli compatibility. This includes expanding enums (category, entity type), changing `dependencies` to accept both string and array formats, adding `machine`/`user_agent` body fields with header fallback, fixing bulk response format to `[HeartbeatBulkItem, code]`, and adding computed `start`/`end`/`timezone` fields to GET responses.

## Technical Context

**Language/Version**: TypeScript (Cloudflare Workers runtime)
**Primary Dependencies**: Hono >= 4.9.7, openapi-typescript
**Storage**: Cloudflare D1 (SQLite) — `heartbeats` table already has `machine` and `user_agent_id` columns
**Testing**: Manual endpoint testing, `npx tsc --noEmit` for type checking
**Target Platform**: Cloudflare Workers (edge compute)
**Project Type**: Web service (API)
**Performance Goals**: <10ms CPU per request (Workers free tier)
**Constraints**: D1 batch insert for bulk ops, no row-at-a-time loops
**Scale/Scope**: Single-user mode, single developer workload

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | Spec changes committed before implementation. Commit order: spec → generate → implement. |
| II. Cloudflare-Native | PASS | No new D1 tables. Bulk insert uses `db.batch()`. GET response fields computed at query time (no extra writes). |
| III. Type Safety | PASS | All schema changes go through `npm run generate`. Route handlers will use generated types. |
| IV. Legal/Trademark | PASS | No WakaTime code referenced. Spec derived from our own OpenAPI schema. |
| V. Simplicity First | PASS | No new abstractions. Dependencies normalization is inline logic. `end` computation reuses existing heartbeat query. |

## Project Structure

### Documentation (this feature)

```text
specs/001-heartbeat-spec-compat/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── heartbeat-input.md
│   └── heartbeat-bulk-response.md
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
schemas/
├── components/
│   ├── schemas/
│   │   ├── HeartbeatInput.yaml      # Updated: add machine, user_agent, expand type/category
│   │   ├── HeartbeatBulkItem.yaml   # New: bulk response item schema
│   │   ├── Category.yaml            # Updated: add 5 values
│   │   └── Heartbeat.yaml           # Updated: add start, end, timezone
│   └── parameters/
│       ├── MachineNameHeader.yaml   # New
│       └── UserAgentHeader.yaml     # New
└── paths/
    └── heartbeats/
        ├── heartbeats.yaml          # Updated: add header params, enrich GET response
        └── heartbeats-bulk.yaml     # Updated: new response schema

src/
├── routes/
│   └── heartbeats.ts                # Updated: bulk response format, dependencies normalization, start/end/timezone
└── types/
    └── generated.ts                 # Regenerated
```

**Structure Decision**: Existing single-project structure. No new directories needed — changes are modifications to existing schema files and route handler.

## Complexity Tracking

No constitution violations to justify.
