# Requirements Checklist: Server-side commit coding-time correlation

**Branch**: `145-commit-duration-correlation` | **Spec**: [spec.md](../spec.md)

Quality gate for the spec before implementation. Each item is verifiable against `spec.md`.

## Completeness

- [x] Every functional requirement (FR-001…FR-011) maps to at least one acceptance scenario or success criterion.
- [x] Where correlation runs is fixed and justified (ingest-time, synchronous; cron/backfill and async queue rejected) — research D-1.
- [x] Precedence fixed: a client-supplied `total_seconds` (incl. explicit `0`) wins and skips correlation; an omitted re-post re-derives — FR-002/FR-009, research D-2.
- [x] Attribution window fixed: `[max(previous_commit, upper − 24h), upper)` with `upper = author_date | ingest-time` — FR-003, research D-3.
- [x] Session-boundary rule fixed: sum gaps `0 < gap <= timeout` (same per-pair rule as `summaries`, via a shared primitive) attributed by `prev.project` (same attribution as `computeDurations`) — FR-005, research D-4.
- [x] Scope fixed: project applied at attribution time (credit gaps by `prev.project`, no project pre-filter of the read), not branch/`ref` — FR-004, research D-5.
- [x] Boundedness fixed: 24h window cap + `LIMIT 5000` + existing index; no full scan — FR-007, research D-6.

## Consistency

- [x] No response/request **shape** change; `Commit`/`CommitInput` fields unchanged; only descriptions clarified — FR-011, contracts/openapi-diff.
- [x] Derived time reconciles with `summaries` methodologically (same gap/timeout rule via shared helper + same `prev.project` attribution), without asserting byte-equality to a stored daily bucket (window is previous-commit-partitioned, rounded once) — FR-005, SC-005.
- [x] No-heartbeats output is byte-identical to the pre-#135/#145 omitted case (absent `total_seconds`, `"0 secs"`) — FR-006, SC-004.
- [x] Correlation touches no aggregates and no other tables' writes — FR-010, data-model "Untouched".
- [x] Supersession of #135 D-3 recorded (client value still wins) without editing #135's historical artifacts — research header, D-2.

## Testability

- [x] Each user story has an Independent Test.
- [x] Success criteria are measurable (SC-001…SC-006).
- [x] Quickstart scenarios A–I cover derive, client-wins, no-heartbeats, consecutive-split, idle-exclusion, re-post re-derive, explicit-zero, boundedness, multi-project attribution.
- [x] The gap/window/summation logic is factored into pure helpers unit-testable without D1 (data-model, tasks T-102/T-105a).

## Compliance

- [x] No PR1 schema change; ingest-time bounded read on the existing `idx_heartbeats_user_time` within a capped window (Cloudflare-Native, Simplicity) — plan Constitution Check.
- [x] Generated-types impact assessed (JSDoc-only) in contracts/openapi-diff.md; types regenerated, never hand-edited.
- [x] Original first-party derivation from our own heartbeat/summary model; no third-party source consulted or payload copied (Legal/Trademark).
- [x] SDD order honored: OpenAPI description edits + regenerated types in PR1; handler + helper + tests in PR2.
