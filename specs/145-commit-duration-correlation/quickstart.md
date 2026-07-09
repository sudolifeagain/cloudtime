# Quickstart: Server-side commit coding-time correlation

**Branch**: `145-commit-duration-correlation`

Manual verification scenarios (run against a worker). These map directly to the PR2 tests. Auth via API key (Bearer). Project from the path; base path:

```
/api/v1/users/current/projects/cloudtime/commits
```

Heartbeats are sent to the existing ingestion endpoint (`POST /api/v1/users/current/heartbeats[.bulk]`) with `project: "cloudtime"` and epoch-seconds `time`s. Assume the user's session `timeout` is 15 minutes.

The attribution window is **inclusive of the commit instant** (`author_date`): a heartbeat at exactly `author_date` is the window's last beat, so the coding interval ending at the commit counts. Several scenarios below place the terminal heartbeat at `author_date` and rely on it.

## A. Derive coding time for a hook-only commit

Send heartbeats for `project=cloudtime` at, e.g., `t, t+120, t+240, … t+1800` (2-minute cadence, all gaps ≤ timeout), ending at `T = t+1800`.

```
POST .../projects/cloudtime/commits
Authorization: Bearer <api_key>
{ "hash": "a1b2c3", "message": "feat: x", "author_date": "<T as RFC3339>" }
```
Expect `201` with `total_seconds ≈ 1800` and `human_readable_total: "30 mins"` — derived from the surrounding heartbeats (no `total_seconds` was sent).

## B. Client-supplied time wins

With the same heartbeats in the window:

```
POST .../projects/cloudtime/commits
{ "hash": "a1b2c3", "message": "feat: x", "author_date": "<T>", "total_seconds": 1234 }
```
Expect `201` with `total_seconds: 1234` (the supplied value, **not** the correlated ~1800). No correlation query runs.

## C. No heartbeats → unchanged "0 secs"

```
POST .../projects/empty/commits
{ "hash": "d4e5f6", "message": "docs", "author_date": "<any>" }
```
With no heartbeats for `project=empty` in the window: expect `201`, `total_seconds` absent, `human_readable_total: "0 secs"` — byte-identical to the pre-#145 output.

## D. Consecutive commits split the session (no double-count)

Heartbeats span one continuous 40-minute session `[t, t+2400]` (gaps ≤ timeout). Commit A at `author_date = t+1200`, commit B at `author_date = t+2400`, both without `total_seconds`:

```
POST .../projects/cloudtime/commits  { "hash": "A", "author_date": "<t+1200>" }
POST .../projects/cloudtime/commits  { "hash": "B", "author_date": "<t+2400>" }
```
Expect A ≈ 1200s and B ≈ 1200s (B's window lower bound is A's `author_date`); A + B ≈ 2400s, the session's active time — not double.

## E. Idle gap excluded (matches summaries)

Heartbeats at `t, t+60, t+120` then a 30-minute idle gap, then `t+1920, t+1980` (timeout 15 min):

```
POST .../projects/cloudtime/commits  { "hash": "G", "author_date": "<t+1980>" }
```
Expect the 30-minute idle gap to contribute 0; `total_seconds ≈ 120 + 60 = 180`s — the same active total the `summaries` gap rule yields for that interval (the idle gap contributes 0).

## F. Re-post re-derives as heartbeats arrive late

Post `hash=L` at `author_date=T` before its heartbeats flushed → `total_seconds` absent. Later send the heartbeats, then re-post the same `{hash:"L", author_date:"<T>"}` (still no `total_seconds`):
```
POST .../projects/cloudtime/commits  { "hash": "L", "author_date": "<T>" }   # again
```
Expect the re-post to now return a derived `total_seconds` (idempotent re-derivation; single row).

## G. Explicit zero is a supplied value

```
POST .../projects/cloudtime/commits  { "hash": "Z", "author_date": "<T>", "total_seconds": 0 }
```
Expect `total_seconds: 0` stored (an explicit `0` is honored as supplied; correlation is skipped) — distinct from the omitted case in C which leaves it absent.

## H. Bounded / best-effort

A window wider than 24h is floored to `author_date − 24h`; a session denser than 5000 heartbeats reads at most 5000 rows (lower-bound estimate). Neither triggers a full scan.

## I. Interleaved other-project heartbeats are attributed by project

Timeout 15 min. Send heartbeats: `cloudtime@t`, `other-proj@t+120`, `cloudtime@t+240`. Commit `cloudtime` at `author_date = t+240`, no `total_seconds`:

```
POST .../projects/cloudtime/commits  { "hash": "M", "author_date": "<t+240>" }
```
Expect `total_seconds ≈ 120`s: correlation gaps the full in-window user stream and credits each gap to its earlier heartbeat's project — the `t → t+120` gap (earlier beat `cloudtime`) counts for this commit; the `t+120 → t+240` gap (earlier beat `other-proj`) is credited to `other-proj`, not absorbed into `cloudtime`. This is exactly how `summaries` splits the two projects (the derivation is **not** a same-project pre-filter, which would have wrongly counted the full `240`s).
