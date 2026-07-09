# Quickstart: Bulk commit ingestion

**Branch**: `147-commits-bulk-ingestion`

Manual verification scenarios (run against a worker). These map directly to the PR2 integration tests. Auth via API key (Bearer). Project comes from the path; base path:

```
/api/v1/users/current/projects/cloudtime/commits.bulk
```

## A. Ingest a batch of commits

```
POST .../projects/cloudtime/commits.bulk
Authorization: Bearer <api_key>
[
  { "hash": "a1", "message": "feat: one",   "author_date": "2026-07-09T01:00:00Z", "ref": "main", "total_seconds": 1800 },
  { "hash": "a2", "message": "fix: two",     "author_date": "2026-07-09T01:10:00Z", "ref": "main", "total_seconds": 600 },
  { "hash": "a3", "message": "docs: three",  "author_date": "2026-07-09T01:20:00Z", "ref": "main" }
]
```
Expect `201` with `{ data: [ … ] }` of three commits in request order. `a1`→`human_readable_total:"30 mins"`, `a2`→`"10 mins"`, `a3`→`total_seconds` absent and `human_readable_total:"0 secs"` (bulk does not correlate heartbeats).

## B. Read them back

```
GET .../projects/cloudtime/commits
GET .../projects/cloudtime/commits/a2
```
Expect the list to include `a1`, `a2`, `a3` (newest-first by `author_date`) and the single GET to return `a2`. `GET ...?branch=main` includes them; `?branch=dev` excludes them.

## C. Omitted total_seconds is NOT correlated

```
POST .../projects/cloudtime/commits.bulk
[ { "hash": "b1", "author_date": "2026-07-09T02:00:00Z" } ]
```
Even with heartbeats surrounding `2026-07-09T02:00:00Z`, read-back `b1` has `total_seconds` absent and `human_readable_total:"0 secs"`. (The single `POST .../commits` would derive it; bulk does not — FR-005.)

## D. All-or-nothing: one bad element rejects the whole batch

```
POST .../projects/cloudtime/commits.bulk
[
  { "hash": "c1", "total_seconds": 100 },
  { "hash": "",   "total_seconds": 200 },
  { "hash": "c3" }
]
```
Expect `400` naming `item 1` (blank hash). Then `GET .../commits` shows **none** of `c1`/`c3` were written.

## E. Validation → 400 (element-level and batch-level)

```
POST .../commits.bulk  { "hash": "x" }                              -> 400 (body must be an array)
POST .../commits.bulk  [ { "message": "no hash" } ]                 -> 400 (item 0: missing hash)
POST .../commits.bulk  [ { "hash": "x", "total_seconds": -5 } ]     -> 400 (item 0: negative total_seconds)
POST .../commits.bulk  [ { "hash": "x", "author_date": "nope" } ]   -> 400 (item 0: bad date)
POST .../commits.bulk  [ …101 valid elements… ]                     -> 400 (over the 100 cap)
```
Each returns `400` and stores nothing.

## F. Empty array

```
POST .../projects/cloudtime/commits.bulk   []
```
Expect `201` with `{ data: [] }` and nothing written.

## G. Idempotent re-post across batches

```
POST .../commits.bulk  [ { "hash": "d1", "message": "first" } ]
POST .../commits.bulk  [ { "hash": "d1", "message": "amended", "total_seconds": 900 } ]
```
Expect both `201`. Then `GET .../commits` shows **one** `d1`, now with the amended message and `total_seconds:900` (no duplicate).

## H. Unauthenticated → 401

```
POST .../projects/cloudtime/commits.bulk   (no/invalid Bearer)
```
Expect `401` (checked before the body is read or validated).

## I. Project from path + cross-user isolation

```
POST .../projects/cloudtime/commits.bulk  [ { "hash": "e1", "project": "other" } ]
```
Expect `e1` stored under `cloudtime` (path), not `other`; `GET .../projects/other/commits` does not list it. A batch posted by user A under `cloudtime` is not returned by user B's `GET .../projects/cloudtime/commits`.
