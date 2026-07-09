# Implementation Plan: Server-side commit coding-time correlation

**Branch**: `145-commit-duration-correlation` | **Date**: 2026-07-10 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/145-commit-duration-correlation/spec.md`

## Summary

When `POST /users/current/projects/{project}/commits` omits `total_seconds`, derive the commit's coding time at ingest time by correlating the user's heartbeats inside a bounded, previous-commit-partitioned window: gap the unfiltered in-window user stream, attribute each interval to its earlier heartbeat's project exactly as `computeDurations` attributes `summaries` time, and sum only the commit's-project intervals with the same session-timeout rule as the daily `summaries`. A client-supplied `total_seconds` always wins and skips correlation. No response/request shape change — the `Commit`/`CommitInput` fields are unchanged; only description prose is corrected (the `createProjectCommit` line that currently says the server does not correlate heartbeats).

**PR1 (this PR)**: SpecKit artifacts + OpenAPI **description-only** edits (`createProjectCommit` prose, `CommitInput.total_seconds` + `Commit.total_seconds` descriptions) + regenerated types (JSDoc-only diff). **No route/business logic, no schema change.**

**PR2 (after PR1 merges)**: the correlation helper + wiring into the `POST` handler + a shared session-gap primitive + integration/unit tests + optional `commits(user_id, project, author_date)` index migration.

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers)
**Primary Dependencies**: Hono >= 4.9.7; existing `src/cron/aggregate.ts` (`computeDurations`), `src/utils/time-format.ts`, `src/utils/commit-input.ts`
**Storage**: D1 — read `heartbeats` (`idx_heartbeats_user_time`) + `commits` + `users.timeout`; write `commits` (existing upsert). No schema change in PR1; PR2 may add one commits index migration.
**Testing**: Vitest + workers pool — unit tests for the pure gap/window helpers; integration tests for derive-on-omit, client-value-wins, consecutive-commit split, idle-gap exclusion, no-heartbeats null, re-post re-derive
**Performance Goals**: <10ms CPU — a capped-window heartbeat read (`LIMIT 5000`) + two single-row reads + one upsert; sub-ms in-memory summation
**Constraints**: reuse the `summaries` gap/timeout rule (shared helper, no drift); bounded query, no full scan; correlation runs only when `total_seconds` is omitted

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | OpenAPI description edits land first (PR1); the handler change + helper follow in PR2. Types regenerated, never hand-edited. |
| II. Cloudflare-Native | PASS | Ingest-time correlation is a bounded read against the existing `idx_heartbeats_user_time` within a 24h-capped window + `LIMIT`; no cron, no full scan, no new binding. Client-value path stays a single upsert. |
| III. Type Safety | PASS | Handler continues to use `components["schemas"]["CommitInput"]`/`["Commit"]`; the derived value flows through the existing `rowToCommit`. |
| IV. Legal/Trademark | PASS | Original first-party derivation from our own heartbeat/summary model; no third-party source consulted or payload copied. |
| V. Simplicity First | PASS | No shape change, no cron, no new table; reuse `computeDurations`' gap rule via a shared primitive; project-only scope; a provenance field explicitly rejected. |

## Project Structure

### Documentation (this feature)

```text
specs/145-commit-duration-correlation/
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
# PR1 (this PR) — description-only
schemas/paths/commits/commits.yaml            # CHANGE: reword createProjectCommit description (correlation now fills omitted total_seconds)
schemas/components/schemas/CommitInput.yaml    # CHANGE: add total_seconds description (server derives when omitted)
schemas/components/schemas/Commit.yaml         # CHANGE: add total_seconds description (may be server-derived)
src/types/generated.ts                         # REGENERATED (npm run generate) — JSDoc-only diff

# PR2 (after PR1 merges)
src/cron/aggregate.ts        # CHANGE: extract the per-pair session-gap rule into a shared pure helper (behavior-preserving)
src/utils/commit-correlation.ts  # NEW: pure window + summation helpers (compute lower/upper, sum active seconds)
src/routes/commits.ts        # CHANGE: when total_seconds omitted, correlate before the upsert; header updated
migrations/000X_commits_author_date_index.sql   # OPTIONAL: idx_commits_user_project_author_date + schema.sql mirror
tests/aggregation/commit-correlation.test.ts     # NEW: pure helper unit tests
tests/integration/commits.test.ts                # EXTEND: correlation scenarios
```

**Structure Decision**: Keep the handler thin. Only when `total_seconds` is omitted: read the user's `timeout`, resolve the previous-commit lower bound and the capped window (epoch bounds via SQLite `strftime('%s', …)`), read the window's heartbeat `time`+`project`s (`ORDER BY time ASC LIMIT 5000`, **not** project-filtered), sum consecutive gaps whose earlier heartbeat's `project` is the commit's project with the shared `sessionGapSeconds(prev, curr, timeout)` primitive (also called by `computeDurations`, whose `prev.project` attribution this replicates), round, and store the result only if `> 0` (else null). The client-value path is unchanged (single upsert). No aggregate writes; `project` from the path; auth via the existing `authMiddleware`.

## Phases

- **PR1 — Spec + Design (this PR)**: author the SpecKit set; reword the three OpenAPI descriptions; `npm run generate` (JSDoc-only diff); `npm run typecheck`.
- **PR2 — Implementation**: extract the shared gap primitive; add the correlation helper; wire it into the `POST` handler behind the omitted-value guard; optional commits index; unit + integration tests; `npm test` green; open PR referencing #145 and PR1.

## Risks & Mitigations

- **Derived time uses a different rule/attribution than `summaries`** → share the exact per-pair gap/timeout primitive between `computeDurations` and correlation **and** replicate its `prev.project` attribution (gap the unfiltered in-window stream, credit each interval to its earlier heartbeat's project) (research D-4); a test uses a multi-project fixture and asserts each in-window interval is attributed to the same project `computeDurations` would credit and that idle gaps > timeout contribute 0 — not that the derived figure equals a stored daily bucket (the window is previous-commit-partitioned and rounded once, unlike day-bucketed `summaries`).
- **Double-counting across consecutive commits** → previous-commit lower bound partitions the timeline (FR-008); a test posts two commits in one session and asserts non-overlapping, summing times.
- **CPU budget / unbounded scan** → 24h window cap + `LIMIT 5000` + existing `idx_heartbeats_user_time`; correlation only runs on the omitted path (research D-6).
- **Timezone/epoch parsing of `author_date`** → convert the stored UTC datetime text to epoch via SQLite `strftime('%s', …)` rather than JS `Date.parse` on the space-separated format (research D-6).
- **Overwriting a client value on re-post** → correlation is strictly gated on omitted `total_seconds`; a present value skips the query (FR-002); the re-derive-on-omitted-re-post behavior is documented (research D-2).
- **Type/shape drift** → PR1 is description-only; the `generate` diff is reviewed to confirm JSDoc-only (no member/shape change).
