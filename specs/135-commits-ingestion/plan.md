# Implementation Plan: Commit ingestion (write path)

**Branch**: `135-commits-ingestion` | **Date**: 2026-06-05 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/135-commits-ingestion/spec.md`

## Summary

Add a dedicated authenticated `POST /users/current/projects/{project}/commits` that ingests one commit, idempotent on `(user_id, project, hash)`, returning 201 with the stored `Commit`. `total_seconds` is client-supplied (the server does not correlate heartbeats). No schema change — the `commits` table and its `(user_id, project, hash)` UNIQUE index already exist.

**PR1 (this PR)**: SpecKit artifacts + OpenAPI (`createProjectCommit` operation + new `CommitInput` request schema, plus the read-op description note) + regenerated types. **No route/business logic.**

**PR2 (after PR1 merges)**: the `POST` handler (validate → upsert → return `Commit`) + integration tests.

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers)
**Primary Dependencies**: Hono >= 4.9.7; zod (already a dependency) for body validation
**Storage**: D1 `commits` (existing) — write via `INSERT … ON CONFLICT(user_id, project, hash) DO UPDATE`
**Testing**: Vitest + workers pool — integration tests for create, idempotent re-post, validation 400s, 401, read-back, cross-user isolation
**Performance Goals**: <10ms CPU — a single-row upsert, no scan
**Constraints**: reuse the existing `commits` table & read-path `rowToCommit` shaping; mirror the external-durations idempotent-POST convention

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | OpenAPI operation + request schema land first (PR1); handler follows in PR2. Types regenerated, never hand-edited. |
| II. Cloudflare-Native | PASS | Single-row D1 upsert keyed on the existing UNIQUE index; no scan, no extra binding. Fast handler, nothing offloaded to cron. |
| III. Type Safety | PASS | Handler uses `components["schemas"]["CommitInput"]` / `["Commit"]` from generated types. |
| IV. Legal/Trademark | PASS | Original first-party endpoint; no third-party source consulted, no provider-specific payload copied. |
| V. Simplicity First | PASS | One operation, one new request schema, no schema change, no heartbeat correlation. Single commit per request; bulk and server-side timing deferred. |

## Project Structure

### Documentation (this feature)

```text
specs/135-commits-ingestion/
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
schemas/paths/commits/commits.yaml          # CHANGE: add `post` (createProjectCommit); note ingestion in the get description
schemas/components/schemas/CommitInput.yaml # NEW: request body schema
src/types/generated.ts                      # REGENERATED (npm run generate)

# PR2 (after PR1 merges)
src/routes/commits.ts                       # CHANGE: add the POST handler (validate + upsert + return Commit); update file header
```

**Structure Decision**: Keep the handler thin. Validate the body with zod (`hash` non-empty; `total_seconds` a number `>= 0` if present; `author_date`/`committer_date` valid date-times if present), normalize dates with the existing `normalizeDateTime`, then a single `INSERT … ON CONFLICT(user_id, project, hash) DO UPDATE SET …` and re-shape the stored row through the existing `rowToCommit` for the 201 response. `project` is read from the path; auth is the existing `authMiddleware`. No new table, no aggregate writes.

## Phases

- **PR1 — Spec + Design (this PR)**: author the SpecKit set; add the `post` operation + `CommitInput`; note ingestion in the read-op prose; `npm run generate`; `npm run typecheck`.
- **PR2 — Implementation**: POST handler + validation + upsert + integration tests; `npm test` green; open PR referencing #135 and PR1.

## Risks & Mitigations

- **Duplicate rows from retries** → idempotent upsert on the existing `(user_id, project, hash)` UNIQUE index (FR-002); integration test posts the same hash twice and asserts a single row.
- **Schema-invalid dates breaking the read path** → validate `author_date`/`committer_date` on ingest and normalize; missing `author_date` falls back to `created_at` in the read path (the #128 fix). (research D-4)
- **Scope creep into server-side timing / webhooks / bulk** → explicitly out of scope; documented in research D-3 and tasks "Out of scope".
- **Type drift** → request/response types are generated from `CommitInput`/`Commit`; the generate diff is reviewed to confirm only the additive operation + schema.
