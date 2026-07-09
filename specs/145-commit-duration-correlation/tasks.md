# Tasks: Server-side commit coding-time correlation

**Branch**: `145-commit-duration-correlation`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Generated**: 2026-07-10 · **Issue**: #145

## PR1 — Spec + Design

- [x] **T-001**: Author `spec.md` (US1 derive-on-omit, US2 client-value-wins, US3 consecutive-split/idle-exclude; FR-001..FR-011; edge cases; SC-001..SC-006).
- [x] **T-002**: Author `plan.md` (Constitution Check; ingest-time correlation; description-only PR1; shared gap primitive in PR2).
- [x] **T-003**: Author `research.md` (D-1 ingest-time, D-2 precedence/re-derive, D-3 window, D-4 shared gap rule, D-5 project-only scope, D-6 bounded queries/constants, D-7 description-only contract).
- [x] **T-004**: Author `data-model.md` (no PR1 schema change; correlation algorithm; shared `sessionGapSeconds`; changed row-mapping cell; optional commits index).
- [x] **T-005**: Author `quickstart.md` (scenarios A–I).
- [x] **T-006**: Author `contracts/openapi-diff.md` (description-only edits; JSDoc-only regen).
- [x] **T-007**: Author `checklists/requirements.md`.
- [x] **T-008**: Reword `schemas/paths/commits/commits.yaml` `createProjectCommit` description — correlation fills an omitted `total_seconds` (remove the "server does not correlate heartbeats" clause).
- [x] **T-009**: Add `total_seconds` descriptions to `schemas/components/schemas/CommitInput.yaml` (server derives when omitted) and `schemas/components/schemas/Commit.yaml` (may be server-derived).
- [x] **T-010**: Run `npm run lint:api`; run `npm run generate` (expect a **JSDoc-only** diff in `src/types/generated.ts` — no member/shape change); confirm with `git diff`; run `npm run typecheck`.
- [x] **T-011**: Commit PR1 in SDD order (spec/schemas, then regenerated types), push, open PR against `develop` referencing #145.

## PR2 — Implementation (after PR1 merges)

- [ ] **T-101**: Extract the per-pair session-gap rule into a shared pure helper `sessionGapSeconds(prevTime, currTime, timeoutSec)` (returns `gap` when `0 < gap <= timeout`, else `0`); refactor `computeDurations` in `src/cron/aggregate.ts` to call it (behavior-preserving — existing aggregation tests stay green).
- [ ] **T-102**: `src/utils/commit-correlation.ts` (new) — pure helpers: `resolveWindow(upperEpoch, prevEpoch, maxWindow)` → `lowerEpoch`, and `sumActiveSeconds(sortedRows, commitProject, timeoutSec)` where `sortedRows` are `{time, project}` ordered by `time`; sums `sessionGapSeconds(prev.time, curr.time, timeoutSec)` only for pairs whose earlier row's `project === commitProject` (replicates `computeDurations`' `prev.project` attribution), then rounds. No D1.
- [ ] **T-103**: `src/routes/commits.ts` — when the validated `total_seconds` is null, correlate before the upsert: resolve `upperText`/`upperEpoch` (`author_date ?? datetime('now')`, epoch via `strftime('%s', …)`), previous-commit `prevEpoch` (`MAX(author_date) … hash != ?`), user `timeout`, window heartbeat `time`+`project`s (`WHERE user_id = ? AND time >= ? AND time <= ?` — inclusive upper per data-model step 5 / research D-6, **not** project-filtered — `ORDER BY time ASC LIMIT 5000`), `sumActiveSeconds(rows, pathProject, timeoutSec)`, store `> 0 ? rounded : null`. Present value → unchanged single upsert. Update the file header.
- [ ] **T-104**: (optional) Add `migrations/000X_commits_author_date_index.sql` + `src/db/schema.sql` mirror for `idx_commits_user_project_author_date`; only if the previous-commit lookup needs bounding at scale (decide against single-user volumes).
- [ ] **T-105a**: Unit tests `tests/aggregation/commit-correlation.test.ts` — `sessionGapSeconds` (idle/out-of-order/exact-timeout boundary), `resolveWindow` (prev-bound vs cap floor), `sumActiveSeconds` (single beat → 0, idle-gap exclusion, rounding, and **interleaved other-project rows**: a `P, Q, P` sequence credits only the `prev===P` gap to P — matching `computeDurations` — using the reviewer's counterexamples as fixtures).
- [ ] **T-105b**: Integration tests `tests/integration/commits.test.ts` (extend) — derive-on-omit (US1), client-value-wins + no-query (US2), consecutive split / no double-count (US3), idle-gap exclusion, **multi-project attribution matches `computeDurations`** (interleaved other-project heartbeats credited by `prev.project`, not absorbed into this commit), no-heartbeats → absent/`"0 secs"`, explicit `0` honored, re-post re-derives, other-project intervals excluded, `author_date` omitted → capped window to now.
- [ ] **T-106**: `npm run lint:api` (no new diagnostics) · `npm run generate` (no drift vs PR1) · `npm run typecheck` (zero errors) · `npm test` (full suite green incl. new tests).
- [ ] **T-107**: Commit with `feat:` prefix, push, open PR against `develop` referencing PR1 and closing #145.

## Dependencies

```
T-001 .. T-010 → T-011                  (PR1)
T-011 → T-101 .. T-107                   (PR2 after PR1 merge)
T-101 → T-102 → T-103 → (T-104) → T-105 → T-106 → T-107
```

## Out of scope

- A cron/backfill correlation pass or re-correlating historical commits (research D-1) — ingest-time only; a re-post re-derives.
- Branch/`ref`-scoped correlation (research D-5) — project-only.
- A `total_seconds` provenance flag or an opt-out param (research D-7) — the omit-vs-supply distinction already carries intent.
- Any change to the `Commit`/`CommitInput` shape, the read endpoints, or the aggregates (`summaries`, `hourly_summaries`, `user_projects`).
- Multi-commit / push-event bulk ingestion (#147) — separate issue.
