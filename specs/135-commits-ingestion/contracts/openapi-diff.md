# OpenAPI Contract Diff: Commit ingestion

**Branch**: `135-commits-ingestion`
**Files**: `schemas/paths/commits/commits.yaml` (path item gains `post`), `schemas/components/schemas/CommitInput.yaml` (new)

This PR1 change is **additive**: a new `post` operation on an existing path and a new request-body schema. `npm run generate` adds `operations["createProjectCommit"]`, a `CommitInput` schema, and flips the commits path item's `post?` from `never` to the operation. No existing operation or schema changes (apart from the read-op description prose).

## 1. New request schema `CommitInput.yaml`

```yaml
type: object
required:
  - hash
properties:
  hash:           { type: string, minLength: 1 }
  message:        { type: string }
  author_name:    { type: string }
  author_email:   { type: string, format: email }
  author_date:    { type: string, format: date-time }
  committer_name: { type: string }
  committer_email:{ type: string, format: email }
  committer_date: { type: string, format: date-time }
  total_seconds:  { type: number, format: double, minimum: 0 }
  ref:            { type: string }
  url:            { type: string, format: uri }
```

(`project` is intentionally **not** a body field — it comes from the path.)

## 2. `commits.yaml` — add the `post` operation

```yaml
post:
  operationId: createProjectCommit
  tags: [commits]
  summary: Ingest a commit for a project
  description: |
    … idempotent on (user_id, project, hash); always 201; project from path;
    total_seconds client-supplied; dates validated; 400 on bad input …
  parameters:
    - name: project
      in: path
      required: true
      schema: { type: string }
  requestBody:
    required: true
    content:
      application/json:
        schema:
          $ref: ../../components/schemas/CommitInput.yaml
  responses:
    '201':
      description: Commit ingested
      content:
        application/json:
          schema:
            type: object
            required: [data]
            properties:
              data:
                $ref: ../../components/schemas/Commit.yaml
    '400': { $ref: ../../components/responses/BadRequest.yaml }
    '401': { $ref: ../../components/responses/Unauthorized.yaml }
```

## 3. Read-op (`get`) description — note ingestion now exists

**Before**: "the ingestion path … is a deliberate follow-up decision and is out of scope here, so the list is empty until commits are populated."

**After**: "populated via the `POST` ingestion endpoint below (a git `post-commit` hook or a webhook adapter posts each commit). The list is empty until commits are ingested."

## Generated types impact

- `src/types/generated.ts`: `paths[".../commits"].post` becomes `operations["createProjectCommit"]`; new `components["schemas"]["CommitInput"]`; new `operations["createProjectCommit"]` with the `application/json` request body and the `201 { data: Commit }` response. No existing member changes.
- Verified by `npm run generate` + reviewing the `git diff` of `src/types/generated.ts` (additive only).
