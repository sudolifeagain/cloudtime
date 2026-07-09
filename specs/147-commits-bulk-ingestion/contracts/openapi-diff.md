# OpenAPI Contract Diff: Bulk commit ingestion

**Branch**: `147-commits-bulk-ingestion`
**Files**:
- `schemas/paths/commits/commits-bulk.yaml` (**new** path item with `post`)
- `schemas/openapi.yaml` (register `/users/current/projects/{project}/commits.bulk`)
- `schemas/components/schemas/CommitInput.yaml` (**description-only** reword of `total_seconds`)

This PR1 change is **additive** plus one description-only edit: a new `post` operation on a new path, reusing the existing `CommitInput` request schema and `Commit` response schema. `npm run generate` adds `operations["createProjectCommitsBulk"]` and the new path member; the `CommitInput` reword changes only a JSDoc description. No existing operation, member, type, format, `required`, or status changes.

## 1. New path item `commits-bulk.yaml` — add the `post` operation

```yaml
post:
  operationId: createProjectCommitsBulk
  tags: [commits]
  summary: Ingest up to 100 commits for a project at once
  description: |
    Batch-ingests commits for the authenticated user under `project` (from the
    path; any `project` in an element is ignored) — the multi-commit counterpart
    to POST .../commits, for a git push or history import. All-or-nothing: every
    element is validated first (same rules as the single ingest) and any invalid
    element returns 400 identifying its index, with nothing written. Valid
    elements are upserted idempotently on (user_id, project, hash) in a single
    batch; re-sent hashes update in place. Returns 201 with the stored commits
    in request order. The cap is 100 per request.

    Unlike the single-commit endpoint, bulk ingestion does NOT derive
    total_seconds from heartbeats: an element's total_seconds is stored verbatim
    when supplied (including an explicit 0) and stored absent when omitted (its
    human_readable_total then reads "0 secs"). A caller needing server-side
    heartbeat correlation posts that commit through POST .../commits or supplies
    total_seconds here.
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
          type: array
          items:
            $ref: ../../components/schemas/CommitInput.yaml
          maxItems: 100
  responses:
    '201':
      description: Commits ingested
      content:
        application/json:
          schema:
            type: object
            required: [data]
            properties:
              data:
                type: array
                items:
                  $ref: ../../components/schemas/Commit.yaml
    '400': { $ref: ../../components/responses/BadRequest.yaml }
    '401': { $ref: ../../components/responses/Unauthorized.yaml }
```

## 2. `schemas/openapi.yaml` — register the path

Under `# --- commits ---`, add the `.bulk` path next to the existing two (mirrors how `heartbeats.bulk` / `external_durations.bulk` are registered):

```yaml
  # --- commits ---
  /users/current/projects/{project}/commits:
    $ref: paths/commits/commits.yaml
  /users/current/projects/{project}/commits.bulk:      # NEW
    $ref: paths/commits/commits-bulk.yaml               # NEW
  /users/current/projects/{project}/commits/{hash}:
    $ref: paths/commits/commit.yaml
```

## 3. `CommitInput.total_seconds` — endpoint-neutral description (description-only)

`CommitInput` is shared by the single and bulk operations, so its `total_seconds` description must not claim the server always derives an omitted value — bulk does not.

**Before**:
> Client-supplied coding time in seconds for the commit. Optional: when omitted the server derives it by correlating heartbeats around the commit (see the ingestion operation). An explicit value (including 0) is stored verbatim and is never overwritten by correlation.

**After**:
> Client-supplied coding time in seconds for the commit. Optional; an explicit value (including 0) is stored verbatim. When omitted, the single `POST .../commits` endpoint derives it by correlating heartbeats around the commit, whereas bulk ingestion (`commits.bulk`) stores it absent — it does not correlate. See each operation.

No `type`/`format`/`minimum`/`required` change — description text only.

## Generated types impact

- `src/types/generated.ts`:
  - new `paths["/users/current/projects/{project}/commits.bulk"]` with `post: operations["createProjectCommitsBulk"]`;
  - new `operations["createProjectCommitsBulk"]` — `project` path param, an `application/json` array-of-`CommitInput` request body, and the `201 { data: Commit[] }` / `400` / `401` responses;
  - the `CommitInput.total_seconds` JSDoc comment updated to the endpoint-neutral wording (no member/type change).
- No existing operation or schema member changes otherwise.
- Verified by `npm run generate` + reviewing the `git diff` of `src/types/generated.ts` (additive operation/path + the one JSDoc reword only).
