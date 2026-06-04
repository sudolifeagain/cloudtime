# Quickstart: Commit ingestion (write path)

**Branch**: `135-commits-ingestion`

Manual verification scenarios (run against a worker). These map directly to the PR2 integration tests. Auth via API key (Bearer). Project comes from the path; base path:

```
/api/v1/users/current/projects/cloudtime/commits
```

## A. Ingest a commit

```
POST .../projects/cloudtime/commits
Authorization: Bearer <api_key>
{
  "hash": "a1b2c3",
  "message": "fix: handle empty range",
  "author_name": "Nao",
  "author_email": "nao@example.com",
  "author_date": "2026-06-05T01:00:00Z",
  "ref": "main",
  "total_seconds": 1800,
  "url": "https://github.com/org/cloudtime/commit/a1b2c3"
}
```
Expect `201` with `{data:{hash:"a1b2c3", message:"fix: handle empty range", total_seconds:1800, human_readable_total:"30 mins", ref:"main", ...}}`.

## B. Read it back

```
GET .../projects/cloudtime/commits
GET .../projects/cloudtime/commits/a1b2c3
```
Expect the list to include `a1b2c3` and the single GET to return it. `GET ...?branch=main` returns it; `?branch=dev` → 404.

## C. Idempotent re-post

```
POST .../projects/cloudtime/commits
{ "hash": "a1b2c3", "message": "fix: handle empty range (amended)", "total_seconds": 2400 }
```
Expect `201`. Then `GET .../commits` shows **one** `a1b2c3`, now with the amended message and `total_seconds:2400` (no duplicate).

## D. Omitted total_seconds

```
POST .../projects/cloudtime/commits
{ "hash": "d4e5f6", "message": "docs", "author_date": "2026-06-05T02:00:00Z" }
```
Expect `201`; read-back `human_readable_total` is `"0 secs"` and `total_seconds` is absent.

## E. Validation → 400

```
POST .../commits  { "message": "no hash" }                 -> 400 (missing hash)
POST .../commits  { "hash": "" }                           -> 400 (blank hash)
POST .../commits  { "hash": "x", "total_seconds": -5 }     -> 400 (negative)
POST .../commits  { "hash": "x", "author_date": "nope" }   -> 400 (bad date)
```
Each returns 400 and stores nothing.

## F. Unauthenticated → 401

```
POST .../projects/cloudtime/commits   (no/invalid Bearer)
```
Expect `401` (checked before body validation).

## G. Project from path

```
POST .../projects/cloudtime/commits  { "hash": "p1", "project": "other" }
```
Expect the commit stored under `cloudtime` (path), not `other`; `GET .../projects/other/commits` does not list it.

## H. Cross-user isolation

A commit posted by user A under `cloudtime` is not returned by user B's `GET .../projects/cloudtime/commits`.
