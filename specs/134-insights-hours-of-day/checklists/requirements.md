# Requirements Checklist: `hours`-of-day insight

**Branch**: `134-insights-hours-of-day` | **Spec**: [spec.md](../spec.md)

Quality gate for the spec before implementation. Each item is verifiable against `spec.md`.

## Completeness

- [x] Every functional requirement (FR-001…FR-010) maps to at least one acceptance scenario or success criterion.
- [x] Aggregation strategy fixed and justified ((a) per-hour table; (b) query-time scan rejected) — research D-1.
- [x] Bucket count and ordering specified (24 buckets, ascending `0…23`) — FR-002, SC-001.
- [x] Average semantics + denominator fixed (mean per distinct active day) — FR-004, research D-3.
- [x] Empty-range behavior specified (24 zero buckets) — spec Edge Cases, SC-001.
- [x] Response field shape enumerated (`hour`, `total_seconds`, `text`) — FR-003.

## Consistency

- [x] Hour bucketing basis matches `summaries.date` (user-profile timezone at aggregation time) — FR-005, research D-7.
- [x] Sums-to-`daily_average` invariant stated and testable — SC-002, data-model.
- [x] Same cron pass + single cursor as `summaries` (incremental constraint) — FR-008, research D-2.
- [x] Out-of-scope items named: `timeout`/`writes_only`/`weekday`, backfill, interval splitting (FR-010, research D-4/D-6).

## Testability

- [x] Each user story has an Independent Test.
- [x] Success criteria are measurable (SC-001…SC-005).
- [x] Quickstart scenarios A–H cover profile, daily_average equality, empty, range vocabulary, 400, 401, timezone, reserved-params.

## Compliance

- [x] No raw-heartbeat scan at request time (Cloudflare-Native) — FR-006, SC-004.
- [x] One new narrow table; generated-types impact assessed (additive) in contracts/openapi-diff.md.
- [x] Semantics derived from our own model; no third-party source consulted (Legal/Trademark) — research D-1/D-3.
- [x] schema.sql-in-PR1 exception is documented and issue-directed (plan.md).
