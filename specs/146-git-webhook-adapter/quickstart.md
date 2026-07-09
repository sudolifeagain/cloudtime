# Quickstart: Git-host webhook adapter

**Branch**: `146-git-webhook-adapter`

Manual verification scenarios (run against a worker). These map directly to the PR2 tests. The **CRUD** uses API-key (Bearer) auth; the **receiver** is public (`security: []`) and authenticates by signature. Base paths:

```
CRUD:     /api/v1/users/current/webhooks
Receiver: /api/v1/webhooks/git/{provider}
```

A GitHub signature is `X-Hub-Signature-256: sha256=<hex>` where `<hex>` is `HMAC-SHA256(raw_body, secret)`. For a manual test:

```
sig=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')
# send header: X-Hub-Signature-256: sha256=$sig   (over the exact bytes in $BODY)
```

## A. Register a repository (owner CRUD)

```
POST .../users/current/webhooks
Authorization: Bearer <api_key>
{ "provider": "github", "repo": "acme/widgets", "project": "widgets", "secret": "s3cr3t" }
```
Expect `201` with `{ data: { id, provider:"github", repo:"acme/widgets", project:"widgets", is_enabled:true, created_at, modified_at } }` — **no `secret` field**. Then `GET .../users/current/webhooks` lists it (again no secret), and `GET .../users/current/webhooks/{id}` returns it.

## B. Deliver a signed GitHub push → commits under the mapped project

```
POST .../webhooks/git/github
X-GitHub-Event: push
X-Hub-Signature-256: sha256=<hmac of the raw body with "s3cr3t">
{
  "ref": "refs/heads/main",
  "repository": { "full_name": "acme/widgets" },
  "commits": [
    { "id": "a1", "message": "feat: one", "timestamp": "2026-07-10T01:00:00Z",
      "url": "https://example.test/acme/widgets/commit/a1",
      "author":    { "name": "Dev One", "email": "dev1@example.test" },
      "committer": { "name": "Dev One", "email": "dev1@example.test" } },
    { "id": "a2", "message": "fix: two", "timestamp": "2026-07-10T01:10:00Z",
      "url": "https://example.test/acme/widgets/commit/a2",
      "author":    { "name": "Dev Two", "email": "dev2@example.test" },
      "committer": { "name": "Dev Two", "email": "dev2@example.test" } }
  ]
}
```
Expect `202` with `{ data: { received:2, ingested:2, skipped:0, project:"widgets" } }`.

## C. Read the commits back (existing endpoints)

```
GET .../users/current/projects/widgets/commits
GET .../users/current/projects/widgets/commits/a2
```
Expect the list to include `a1`, `a2` (newest-first by `author_date`), `ref:"refs/heads/main"`, and each with `total_seconds` **absent** and `human_readable_total:"0 secs"` (the webhook path does not correlate heartbeats — even with heartbeats surrounding those timestamps). `GET ...?branch=refs/heads/main` includes them; `?branch=refs/heads/dev` excludes them.

## D. A GitLab push

```
POST .../webhooks/git/gitlab
X-Gitlab-Event: Push Hook
X-Gitlab-Token: s3cr3t                       (must equal the registration secret)
{
  "ref": "refs/heads/main",
  "project": { "path_with_namespace": "acme/widgets" },
  "commits": [ { "id": "g1", "message": "chore", "timestamp": "2026-07-10T02:00:00Z",
                 "url": "https://gitlab.test/acme/widgets/-/commit/g1",
                 "author": { "name": "Dev", "email": "dev@example.test" } } ]
}
```
With a GitLab registration for `acme/widgets`, expect `202` `{ received:1, ingested:1, skipped:0, project:"widgets" }`. (`committer_*` omitted — not in the GitLab payload.)

## E. Verification failures write nothing

```
POST .../webhooks/git/github  (X-Hub-Signature-256 wrong / missing)    -> 401
POST .../webhooks/git/github  (payload repo "acme/unknown", no registration) -> 404
POST .../webhooks/git/gitlab  (X-Gitlab-Token != secret)               -> 401
POST .../webhooks/git/bitbucket  (unsupported provider)                -> 404
POST .../webhooks/git/github  (body is not valid JSON)                 -> 400
```
Each writes nothing — a follow-up `GET .../projects/widgets/commits` is unchanged.

## F. Ping / non-push events are acknowledged

```
POST .../webhooks/git/github
X-GitHub-Event: ping
{ "zen": "…", "repository": { "full_name": "acme/widgets" } }
```
Expect `202` `{ received:0, ingested:0, skipped:0 }` — accepted, nothing ingested (so the host does not disable the hook). A recognized non-`push` event (e.g. `pull_request`) behaves the same.

## G. Disabled registration is treated as unregistered

```
PATCH .../users/current/webhooks/{id}   { "is_enabled": false }
POST  .../webhooks/git/github           (signed push for acme/widgets)   -> 404
```
Re-enable with `PATCH … { "is_enabled": true }` and the same push returns `202`.

## H. Idempotent redelivery

```
POST .../webhooks/git/github   (signed push containing a1)
POST .../webhooks/git/github   (signed redelivery of the same push, a1 with an amended message)
```
Both `202`. Then `GET .../projects/widgets/commits` shows **one** `a1` with the amended message — no duplicate (idempotent on `(user, project, hash)`).

## I. Best-effort: a malformed commit is skipped, the rest ingest

```
POST .../webhooks/git/github   (signed push; one commit object has no "id", two are valid)
```
Expect `202` `{ received:3, ingested:2, skipped:1, project:"widgets" }`; the two valid commits are stored. A commit with a very long `message` is ingested with the message clamped to the stored cap (not dropped).

## J. CRUD: patch, immutability, duplicate, delete, auth

```
PATCH  .../users/current/webhooks/{id}  { "project": "widgets-v2" }        -> 200 (project changed)
PATCH  .../users/current/webhooks/{id}  { "provider": "gitlab" }           -> 400 (immutable)
POST   .../users/current/webhooks       { same provider+repo again }        -> 409 (duplicate)
GET    .../users/current/webhooks/{unknown-or-other-user-id}                -> 404
DELETE .../users/current/webhooks/{id}                                      -> 204
POST   .../webhooks/git/github  (signed push for the deleted repo)         -> 404
POST   .../users/current/webhooks   (no/invalid Bearer)                    -> 401 (before body validation)
```

## K. Secret is write-only + cross-user isolation

- No response from A (create/read/list) ever contains a `secret` field (SC-004).
- A registration and its webhook-ingested commits created by owner A are never visible to owner B (`GET` returns `404` for B's request against A's id; B's project list does not include A's commits).
