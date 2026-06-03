# Requirements Checklist: `weekday` filter for the `days` insight

**Branch**: `133-insights-weekday-filter` | **Spec**: [spec.md](../spec.md)

Quality gate for the spec before implementation. Each item is verifiable against `spec.md`.

## Completeness

- [x] Every functional requirement (FR-001…FR-009) maps to at least one acceptance scenario.
- [x] Numbering convention (0=Sunday) is fixed and justified (research D-1).
- [x] Accepted input forms enumerated: integer 0–6 and case-insensitive full names (FR-002/FR-003).
- [x] Omitted-parameter behavior specified (FR-005).
- [x] Invalid-input behavior specified per insight type (FR-006 days → 400; FR-007 others → ignore).

## Consistency

- [x] Filtering basis matches the existing `weekday` insight (FR-008, research D-4).
- [x] `days[]` ordering and entry shape preserved (FR-004).
- [x] Out-of-scope items named: `timeout`, `writes_only` (FR-009), no schema change (data-model).

## Testability

- [x] Each user story has an Independent Test.
- [x] Success criteria are measurable (SC-001…SC-005).
- [x] Quickstart scenarios A–H cover filter, equivalence, empty, 400, ignore, and cross-insight consistency.

## Compliance

- [x] No new D1 table / migration (Cloudflare-Native, Simplicity).
- [x] Generated-types impact assessed (JSDoc-only) in contracts/openapi-diff.md.
- [x] Convention chosen for internal consistency; no WakaTime source consulted (Legal/Trademark).
