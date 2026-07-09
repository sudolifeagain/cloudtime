# Feature Specification: Server-side commit coding-time correlation

**Feature Branch**: `145-commit-duration-correlation`
**Created**: 2026-07-10
**Status**: Draft
**Input**: Commit ingestion (#135) stores a **client-supplied** `total_seconds` and the server does not compute coding time (research D-3, `specs/135-commits-ingestion/research.md`). A bare git `post-commit` hook has no coding-time figure, so those commits render `total_seconds: null` / `human_readable_total: "0 secs"`. Issue #145.

## Background

CloudTime already ingests commits via `POST /users/current/projects/{project}/commits` (#135). That endpoint takes an optional `total_seconds` and stores it verbatim; when omitted, the commit shows no coding time. A plugin that already knows the figure can supply it, but the most common caller — a bare git `post-commit` hook — does not, so its commits are timeless.

Meanwhile the heartbeat stream already records exactly when the author was coding in that project. This feature **derives** a commit's coding time by correlating the heartbeats around it, but only when the client did not supply `total_seconds`. It is the follow-up that #135's research D-3 explicitly deferred ("Heartbeat↔commit correlation … belongs in a separate issue").

The correlation runs **at ingest time**, synchronously inside the existing `POST` handler (research D-1): a fresh commit's heartbeats are recent and present, the result is immediate, and re-posting re-derives — so no new cron pass, watermark, or backfill state is introduced. The window, session boundaries, scope, and precedence are fixed in research D-2…D-6.

This is a **behavior** change to an existing endpoint, not a shape change: the `Commit` response and `CommitInput` request keep their fields. The only contract edits are description clarifications (the `createProjectCommit` prose that currently states "the server does not correlate heartbeats" is now false and must be reworded).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A bare git hook's commit gets its coding time (Priority: P1)

As an authenticated user whose `post-commit` hook posts only a `hash` (no `total_seconds`), I want the server to fill in the commit's coding time from the heartbeats I already sent while working on it.

**Why this priority**: This is the feature — without it, hook-only commits are permanently timeless.

**Independent Test**: Send heartbeats for `project=cloudtime` spanning ~30 active minutes ending at time `T`, then `POST .../projects/cloudtime/commits` with `{hash, author_date: T}` and **no** `total_seconds`; the response's `total_seconds` is the summed active time (≈1800) and `human_readable_total` is `"30 mins"`.

**Acceptance Scenarios**:

1. **Given** heartbeats for the commit's project inside the attribution window, **When** posting a commit that omits `total_seconds`, **Then** the stored `total_seconds` equals the summed active coding time and `human_readable_total` is derived from it.
2. **Given** no heartbeats in the window, **When** posting a commit that omits `total_seconds`, **Then** `total_seconds` stays absent and `human_readable_total` is `"0 secs"` — identical to the pre-#145 behavior.
3. **Given** the commit's project has heartbeats but a **different** project also has heartbeats in the same interval, **When** correlating, **Then** only coding time attributed to the commit's project contributes — each idle-trimmed interval is credited to the project of its earlier heartbeat, exactly as `summaries` attributes project time, so the other project's interval is credited to that project and not to this commit (research D-5).

---

### User Story 2 - A client-supplied time always wins (Priority: P1)

As a plugin author that already computes the commit's coding time, I want my supplied `total_seconds` to be stored exactly, without the server second-guessing it.

**Why this priority**: Correlation is a best-effort fallback; an authoritative client figure must never be overwritten by a derived one, and the fast single-write path must stay fast.

**Independent Test**: `POST` a commit with `total_seconds: 1234` while heartbeats exist in the window; read-back shows `total_seconds: 1234` (not the correlated value), and no heartbeat correlation query is performed.

**Acceptance Scenarios**:

1. **Given** `total_seconds` present (a number `>= 0`) in the body, **When** posting, **Then** it is stored verbatim and correlation is skipped entirely (the write stays a single upsert).
2. **Given** `total_seconds: 0` explicitly supplied, **When** posting, **Then** `0` is stored (an explicit zero is a value, not "omitted").
3. **Given** a re-post of the same `hash` that omits `total_seconds`, **When** re-ingested, **Then** the server re-derives from heartbeats (consistent with the existing full-overwrite upsert, #135 D-2) — a re-post does not preserve a previously client-supplied figure.

---

### User Story 3 - Consecutive commits split the session, idle time is excluded (Priority: P2)

As a user who makes several commits during one coding session, I want each commit's derived time to cover only the coding since my previous commit, and idle gaps to be excluded, so per-commit times are meaningful and don't double-count.

**Why this priority**: Without a previous-commit boundary, every commit would re-count the whole session; without the session-timeout rule, long breaks would inflate the figure and diverge from `summaries`.

**Independent Test**: In one project, commit A at `T0`, keep coding, commit B at `T1`; each posted without `total_seconds`. B's derived time covers only `[T0, T1)`; A's and B's derived seconds sum to the session's active time, not double it. A heartbeat gap longer than the user's timeout inside a window is not counted.

**Acceptance Scenarios**:

1. **Given** a previous commit on the same project at `T0` and this commit's `author_date` at `T1`, **When** correlating, **Then** the attribution window's lower bound is `T0` (the timeline is partitioned; `[T0, T1)` coding is attributed to this commit only).
2. **Given** two heartbeats separated by more than the user's session timeout inside the window, **When** summing, **Then** that idle gap is excluded — the same gap/timeout rule the daily `summaries` use.
3. **Given** no previous commit within the capped lookback, **When** correlating, **Then** the window's lower bound is `author_date - MAX_CORRELATION_WINDOW` (bounded lookback), and idle-gap trimming still applies.

### Edge Cases

- **Client value present** → stored verbatim; no correlation query runs (US2). Only an omitted/null `total_seconds` triggers correlation.
- **No heartbeats in window** → derived time is `0`; stored as null so `total_seconds` is absent and `human_readable_total` is `"0 secs"` (byte-identical to pre-#145 output; no misleading measured "0").
- **`author_date` omitted** → the window ends at the ingest instant (`now`, matching the read-path `created_at` fallback); the previous-commit lower bound still applies (with `upper = now`, the most recent prior commit on the project before `now` floors the window), and the floor is capped at `now − MAX_CORRELATION_WINDOW` — a bounded best-effort correlation.
- **`author_date` in the future (clock skew)** → the window's upper bound is that future instant, but only heartbeats that actually exist (up to now) contribute, so the sum is naturally bounded.
- **Out-of-order ingestion** (a later commit ingested before an earlier one) → the later commit transiently has no previous-commit bound and may overlap; re-posting it after the earlier commit exists re-derives against the now-present boundary.
- **Previous commit has a null `author_date`** → it cannot serve as a lower bound (skipped); the capped-window floor applies.
- **Re-post as heartbeats arrive late** → re-posting the same hash re-derives, so a commit posted before its heartbeats flushed can be corrected by a later identical post.
- **Very dense session exceeding the row cap** → correlation reads at most `CORRELATION_HEARTBEAT_LIMIT` heartbeats; a session denser than that yields a lower-bound estimate (best-effort, documented) rather than an unbounded scan.
- **Heartbeats purged** → correlation is best-effort against whatever heartbeats remain; ingest-time correlation sidesteps this because a fresh commit's heartbeats are recent.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When a `POST .../commits` body omits `total_seconds` (absent or null), the system MUST derive the commit's coding time by correlating the authenticated user's heartbeats for the path `project`, at ingest time inside the request.
- **FR-002**: When `total_seconds` is present and a number `>= 0`, the system MUST store it verbatim and MUST NOT run correlation (client-supplied value always wins; the fast single-upsert path is preserved). An explicit `0` is a supplied value, not an omission.
- **FR-003**: The attribution window MUST be `[lower, upper)` where `upper` is the commit's `author_date` (or the ingest instant when `author_date` is omitted) and `lower` is `max(previous_commit_author_date, upper − MAX_CORRELATION_WINDOW)`, with `previous_commit_author_date` = the greatest `author_date` strictly before `upper` among the same user's other commits in the same project (a null-`author_date` prior commit is not eligible).
- **FR-004**: Correlation MUST read the authenticated user's (`user_id`-scoped) heartbeats with `time` within `[lower, upper)` ordered by `time` — **not** pre-filtered by `project` — and MUST attribute each consecutive gap to the `project` of its earlier heartbeat, mirroring how `computeDurations` attributes `summaries` time. Only gaps whose earlier heartbeat's `project` equals the commit's path `project` contribute to the derived total; intervals belonging to other projects are excluded. Correlation MUST NOT filter on branch/`ref` (research D-5).
- **FR-005**: The derived seconds MUST be the sum, over consecutive in-window heartbeat pairs attributed to the commit's project (FR-004), of gaps where `0 < gap <= user.timeout` — the **same** per-pair idle/timeout rule and the **same** `prev.project` attribution the daily `summaries` aggregation applies (both share the `sessionGapSeconds` primitive and gap the same unfiltered user stream). Idle gaps beyond the timeout and intervals belonging to other projects therefore contribute zero, exactly as they do in `summaries`. The derived figure need not equal any stored daily `summaries` bucket: the correlation window is partitioned by the previous commit and rounded once, whereas `summaries` are day-bucketed and rounded per bucket — the *rule and attribution* are identical, the aggregation boundaries are not.
- **FR-006**: The derived value MUST be rounded to whole seconds (the `summaries` convention). It MUST be stored only when `> 0`; a derived `0` (or no heartbeats) MUST be stored as null so the response omits `total_seconds` and renders `"0 secs"` — indistinguishable from the pre-#145 omitted case.
- **FR-007**: Correlation MUST be a bounded operation: a window capped at `MAX_CORRELATION_WINDOW` and a heartbeat read capped at `CORRELATION_HEARTBEAT_LIMIT` rows — never a full-table scan — so the handler stays within the Workers request CPU budget.
- **FR-008**: Consecutive commits MUST NOT double-count: the previous-commit lower bound partitions the timeline so `[T_prev, T_this)` coding is attributed to `T_this`'s commit only.
- **FR-009**: A re-post of the same `(user_id, project, hash)` that omits `total_seconds` MUST re-derive (consistent with the idempotent full-overwrite upsert, #135 D-2); the previous-commit lookup MUST exclude the commit's own `hash` so a re-post does not use itself as a boundary.
- **FR-010**: Correlation MUST read only the `heartbeats` and `commits` tables and MUST NOT modify `summaries`, `hourly_summaries`, `heartbeats`, `user_projects`, or any aggregate — commits remain an independent series (preserves #135 FR-010).
- **FR-011**: The response and request **shape** MUST NOT change: `Commit` and `CommitInput` keep their fields; only description prose is clarified (the `createProjectCommit` line stating the server does not correlate heartbeats is corrected).

### Key Entities

- **`heartbeats`** (existing, read-only here): read `user_id`-scoped over the `[lower, upper)` `time` window (not pre-filtered by `project`); `project` is read alongside `time` so each gap is attributed to its earlier heartbeat's project. `time` is Unix epoch seconds. Served by the existing `idx_heartbeats_user_time` index within the capped window.
- **`commits`** (existing, no shape change): the previous-commit lower bound reads `author_date` for the same `(user_id, project)`; `total_seconds` is the write target. `author_date` is stored as a SQLite datetime (UTC text).
- **`users`** (existing, read-only here): supplies the session `timeout` (minutes → seconds) so the gap rule matches `summaries`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A commit posted without `total_seconds`, with heartbeats spanning `N` active seconds in its window, returns `total_seconds` within rounding of `N` and the matching `human_readable_total`.
- **SC-002**: A commit posted with `total_seconds: V` round-trips `V` unchanged, regardless of any heartbeats in the window, and performs no correlation query.
- **SC-003**: Two consecutive commits in one continuous session, each posted without `total_seconds`, have derived times that sum to the session's active time (no interval double-counted).
- **SC-004**: A commit with no heartbeats in its window returns absent `total_seconds` and `"0 secs"` — byte-identical to the pre-#145 response for the same input.
- **SC-005**: An idle gap longer than the user's timeout inside a window contributes zero seconds to the derived total, and an in-window interval whose earlier heartbeat belongs to another project contributes zero — the derivation applies the same idle/timeout gap rule and the same `prev.project` attribution as the `summaries` aggregation (it is not asserted to equal a stored daily `summaries` bucket, whose day-bucketing and per-bucket rounding differ from the single previous-commit-partitioned window).
- **SC-006**: Correlation issues a bounded number of queries against a capped window (no full scan) and stays within the request CPU budget for a `MAX_CORRELATION_WINDOW`-wide window at typical heartbeat cadence.
