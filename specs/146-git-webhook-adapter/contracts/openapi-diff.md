# OpenAPI Contract Diff: Git-host webhook adapter

**Branch**: `146-git-webhook-adapter`
**Files**:
- `schemas/paths/webhooks/git-provider.yaml` (**new** — `post` `receiveGitWebhook`, public `security: []`)
- `schemas/paths/webhooks/webhooks.yaml` (**new** — `get` `listGitWebhooks` + `post` `createGitWebhook`)
- `schemas/paths/webhooks/webhook.yaml` (**new** — `get`/`patch`/`delete` on `{webhook_id}`)
- `schemas/components/schemas/WebhookEndpoint.yaml` (**new** — output, no secret)
- `schemas/components/schemas/WebhookEndpointInput.yaml` (**new** — input, secret required + `writeOnly`)
- `schemas/openapi.yaml` (register the three paths under a new `# --- webhooks ---` banner; add the `git_webhooks` tag)

This PR1 change is **purely additive**: three new path items (six new operations), two new component schemas, three new path registrations, and one new tag. No existing operation, schema, member, type, format, `required`, or status changes. `npm run generate` adds the six operations, the three path members, the two schemas, and the tag; nothing existing changes.

## 1. `webhooks/git-provider.yaml` — public receiver (`receiveGitWebhook`)

Public (`security: []`, mirroring `cards/public-card.yaml`). `{provider}` path enum `github`/`gitlab`; documented header params for the provider event + signature/token; a freeform `application/json` body (the provider payload); responses:

- `202` — `{ data: { received, ingested, skipped, project? } }` (a push ingests commits; `ping`/non-`push` returns zero counts).
- `400` — unparseable body / missing identifying fields.
- `401` — signature/token verification failed.
- `404` — unsupported provider, or no enabled registration for the payload's repository.

Placement of `security: []`: method-level, right after `description:` and before `parameters:` (same as `public-card.yaml`). The `401` here documents a *verification* failure, not an API-key scheme failure.

## 2. `webhooks/webhooks.yaml` — owner CRUD collection

- `get` `listGitWebhooks` → `200 { data: WebhookEndpoint[] }`, `401`.
- `post` `createGitWebhook` → body `WebhookEndpointInput`; `201 { data: WebhookEndpoint }`, `400`, `401`, `409` (duplicate `(provider, repo)`).

Inherits the global `security` (omits the key) — API-key/session authed, like `commits.yaml`.

## 3. `webhooks/webhook.yaml` — owner CRUD item (`{webhook_id}`)

File-level `{webhook_id}` path param (uuid). `get` `getGitWebhook` (`200`/`401`/`404`), `patch` `updateGitWebhook` (partial body `project`/`secret`/`is_enabled`; `provider`/`repo` immutable → `400`; `200`/`400`/`401`/`404`), `delete` `deleteGitWebhook` (`204`/`401`/`404`).

## 4. New schemas

**`WebhookEndpoint`** (output) — `id` (uuid), `provider` (enum), `repo`, `project`, `is_enabled` (boolean), `created_at`, `modified_at` (date-time). **No `secret`** — the secret is write-only (FR-009).

**`WebhookEndpointInput`** (input) — `provider` (enum `github`/`gitlab`, required), `repo` (required, 1–255), `project` (required, 1–255), `secret` (required, 1–255, **`writeOnly: true`**), `is_enabled` (optional, default `true`).

## 5. `schemas/openapi.yaml` — register paths + tag

Under a new `# --- webhooks ---` banner (between `# --- ai ---` and `# --- orgs ---`):

```yaml
  # --- webhooks ---
  /webhooks/git/{provider}:
    $ref: paths/webhooks/git-provider.yaml
  /users/current/webhooks:
    $ref: paths/webhooks/webhooks.yaml
  /users/current/webhooks/{webhook_id}:
    $ref: paths/webhooks/webhook.yaml
```

And a `git_webhooks` tag added to `tags:` (after `ai`):

```yaml
  - name: git_webhooks
    description: Git-host push webhook receiver and repository→project registrations
```

## Generated types impact

- `src/types/generated.ts`:
  - new `paths["/webhooks/git/{provider}"]` with `post: operations["receiveGitWebhook"]`;
  - new `paths["/users/current/webhooks"]` with `get: operations["listGitWebhooks"]`, `post: operations["createGitWebhook"]`;
  - new `paths["/users/current/webhooks/{webhook_id}"]` with `get`/`patch`/`delete` (`getGitWebhook`/`updateGitWebhook`/`deleteGitWebhook`);
  - new `operations[…]` for all six, and new `components["schemas"]["WebhookEndpoint"]` / `["WebhookEndpointInput"]`.
- No existing operation or schema member changes.
- Verified by `npm run generate` + reviewing the `git diff` of `src/types/generated.ts` (additive operations/paths/schemas + the new tag only; `schemas/_bundled/openapi.yaml` stays gitignored).
