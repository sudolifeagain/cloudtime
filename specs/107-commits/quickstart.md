# Quickstart: Commits Read Endpoints

Manual verification once PR2 (implementation) is deployed. Because ingestion
is deferred, seed the `commits` table directly first.

## Prerequisites

```bash
export API_KEY=ck_xxx
export BASE=https://cloudtime.example.dev/api/v1
export H="Authorization: Bearer $API_KEY"
```

Seed a couple of commits (substitute your `user_id`):

```bash
wrangler d1 execute cloudtime-db --remote --command "
  INSERT INTO commits (id, user_id, project, hash, message, author_name, author_email,
                       author_date, total_seconds, ref) VALUES
   (lower(hex(randomblob(16))),'<uid>','cloudtime','abc123','fix bug','Nao','nao@example.com','2026-05-20T10:00:00Z',1800,'main'),
   (lower(hex(randomblob(16))),'<uid>','cloudtime','def456','add feature','Nao','nao@example.com','2026-05-21T10:00:00Z',3600,'main');
"
```

## Scenario A — List a project's commits

```bash
curl -sH "$H" "$BASE/users/current/projects/cloudtime/commits"
```

**Expected**: `{data:[…], page:1, total_pages:1}` ordered newest-first (`def456` then `abc123`), each with `human_readable_total` (e.g. "1 hr", "30 mins").

## Scenario B — Pagination

```bash
curl -sH "$H" "$BASE/users/current/projects/cloudtime/commits?page=2"
```

**Expected**: with ≤100 commits, page 2 returns `{data:[], page:2, total_pages:1}` (empty, not an error). An invalid `page` (e.g. `?page=abc` or `?page=0`) returns 400.

## Scenario C — Filters

```bash
curl -sH "$H" "$BASE/users/current/projects/cloudtime/commits?author=nao@example.com"
curl -sH "$H" "$BASE/users/current/projects/cloudtime/commits?branch=main"
```

**Expected**: only commits matching `author_email` / `ref` return.

## Scenario D — Single commit

```bash
curl -sH "$H" "$BASE/users/current/projects/cloudtime/commits/abc123"
curl -si -H "$H" "$BASE/users/current/projects/cloudtime/commits/nope"
```

**Expected**: the first returns `{data: Commit}` with `human_readable_total`; the unknown hash returns 404.

## Scenario E — Empty project

```bash
curl -sH "$H" "$BASE/users/current/projects/never-seen/commits"
```

**Expected**: `{data:[], page:1, total_pages:0}` with 200.

## Scenario F — Auth / isolation

```bash
curl -si "$BASE/users/current/projects/cloudtime/commits"   # no auth → 401
```

**Expected**: 401. Another user's commits for a same-named project never appear.

## Reverting / cleanup

Read-only. Removing the route + mount disables the feature with no data impact.
