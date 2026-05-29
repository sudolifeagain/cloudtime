# OpenAPI Diff

The two `commits` read operations (`getProjectCommits`, `getProjectCommit`)
and the `Commit` schema already existed. This PR adds descriptions, a `400`
on the list, explicit pagination requirements, and makes
`human_readable_total` required because handlers always derive it from stored
seconds.

## Files touched

1. `schemas/paths/commits/commits.yaml` — `getProjectCommits`: add `description`
   (pagination 100/page, `author_date` DESC, `author`/`branch` filters,
   `human_readable_total` derivation, read-only / ingestion-deferred note), a
   `400` response (invalid `page`), `page` default/minimum, and required
   `page` / `total_pages` response fields.
2. `schemas/paths/commits/commit.yaml` — `getProjectCommit`: add `description`
   (single by `project` + `hash`, optional `branch`/`ref` filter, 404 for
   unknown/cross-user/branch mismatch).
3. `schemas/components/schemas/Commit.yaml` — make `human_readable_total`
   required and document that it is derived from `total_seconds`.

No new operations or path changes.

## Contract

- `GET /users/current/projects/{project}/commits?page=&author=&branch=` →
  `200 {data: Commit[], page, total_pages}`, `400`, `401`.
- `GET /users/current/projects/{project}/commits/{hash}?branch=` →
  `200 {data: Commit}`, `401`, `404`.

`Commit` carries `hash`, `message`, author/committer name/email/date,
`total_seconds`, required `human_readable_total`, `ref`, `url`.

## Generated-types impact

`npm run generate` adds the `400` (BadRequest) response to
`operations["getProjectCommits"]` plus the JSDoc descriptions. The list
response now requires `page` and `total_pages`; `Commit` now requires
`human_readable_total`.

## Ingestion — explicitly not in the contract

No `POST` / create operation is added. Ingestion (CLI-plugin vs git-webhook)
is deferred to a follow-up (see research Decision 1); the read endpoints
return whatever is in the `commits` table.

## SDD compliance note

PR1 lands SpecKit + the `400` / descriptions + regenerated types. PR2 lands
the two read handlers + tests. No runtime code in PR1.
