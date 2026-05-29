# OpenAPI Diff

The two `commits` read operations (`getProjectCommits`, `getProjectCommit`)
and the `Commit` schema already existed. This PR adds descriptions and a `400`
on the list. No schema field changes.

## Files touched

1. `schemas/paths/commits/commits.yaml` — `getProjectCommits`: add `description`
   (pagination 100/page, `author_date` DESC, `author`/`branch` filters,
   `human_readable_total` derivation, read-only / ingestion-deferred note) and
   a `400` response (invalid `page`).
2. `schemas/paths/commits/commit.yaml` — `getProjectCommit`: add `description`
   (single by `project` + `hash`, 404 for unknown/cross-user).

No new operations, no path changes, no schema field changes.

## Contract (shape unchanged)

- `GET /users/current/projects/{project}/commits?page=&author=&branch=` →
  `200 {data: Commit[], page, total_pages}`, `400`, `401`.
- `GET /users/current/projects/{project}/commits/{hash}` →
  `200 {data: Commit}`, `401`, `404`.

`Commit` carries `hash`, `message`, author/committer name/email/date,
`total_seconds`, `human_readable_total`, `ref`, `url`.

## Generated-types impact

`npm run generate` adds the `400` (BadRequest) response to
`operations["getProjectCommits"]` plus the JSDoc descriptions. No
request/response **body** type changes — `Commit` is untouched.

## Ingestion — explicitly not in the contract

No `POST` / create operation is added. Ingestion (CLI-plugin vs git-webhook)
is deferred to a follow-up (see research Decision 1); the read endpoints
return whatever is in the `commits` table.

## SDD compliance note

PR1 lands SpecKit + the `400` / descriptions + regenerated types. PR2 lands
the two read handlers + tests. No runtime code in PR1.
