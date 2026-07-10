# Data Model: Git-host webhook adapter

**Branch**: `146-git-webhook-adapter` | **Date**: 2026-07-10

## Storage

### NEW table `webhook_endpoints` (migration `0008`, PR2)

One row per registration: a `(provider, repo)` → `project` mapping plus the encrypted per-repo secret. Mirrors the `ai_model_prices` per-user config conventions (TEXT `id`, `user_id` FK `ON DELETE CASCADE`, `is_enabled` flag, `datetime('now')` timestamps, `idx_<table>_<cols>` indexes) and the OAuth `*_encrypted` secret-at-rest column pattern. **This DDL is documented here in PR1; the migration + `schema.sql` mirror land in PR2 (implementation), not the docs PR.**

```sql
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,               -- 'github' | 'gitlab'
  repo TEXT NOT NULL,                   -- provider repo identity: GitHub full_name / GitLab path_with_namespace
  project TEXT NOT NULL,                -- CloudTime project the commits land under
  secret_encrypted TEXT NOT NULL,       -- AES-256-GCM (ENCRYPTION_KEY, AAD 'webhook:<id>'); never plaintext, never a hash
  is_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  modified_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, provider, repo)
);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_user ON webhook_endpoints(user_id);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_lookup ON webhook_endpoints(provider, repo);
```

- `UNIQUE(user_id, provider, repo)` — one registration per repo per user; a second create for the same key → `409` (FR-010). Two different users may register the same public repo (multi-user-ready).
- `idx_webhook_endpoints_lookup (provider, repo)` — backs the delivery-time lookup (FR-002). In single-user mode this resolves to exactly one row (research D-9).
- `idx_webhook_endpoints_user (user_id)` — backs the owner CRUD list (FR-008).

### Existing table `commits` (no schema change)

The receiver writes the same `commits` columns the single/bulk endpoints write, on the existing `(user_id, project, hash)` UNIQUE index (`src/db/schema.sql`) — the idempotent upsert backing FR-005. No change.

## Registration CRUD (owner-authenticated)

### Request → row (create `POST /users/current/webhooks`)

Body is a `WebhookEndpointInput`; `user_id` is the authenticated owner.

| Body field | Column | Notes |
|---|---|---|
| — (auth) | `user_id` | authenticated owner |
| — (server) | `id` | `crypto.randomUUID()` |
| `provider` (required, enum `github`\|`gitlab`) | `provider` | immutable after create (FR-010) |
| `repo` (required, non-empty, ≤255) | `repo` | provider repo identity; immutable after create |
| `project` (required, non-empty, ≤255) | `project` | mutable |
| `secret` (required, non-empty) | `secret_encrypted` | `encryptToken(secret, ENCRYPTION_KEY, 'webhook:'+id)`; **write-only** — never returned (FR-009) |
| `is_enabled` (optional, default `true`) | `is_enabled` | mutable |

`PATCH /users/current/webhooks/{webhook_id}` accepts `project`, `secret`, `is_enabled`; `provider`/`repo` in the body → `400` (immutable). The PATCH body schema does not set `additionalProperties: false` (matching the `/ai/prices` precedent), so `provider`/`repo` in a body pass schema validation and the immutability `400` is enforced by the handler (FR-010), not by the schema. Ownership + existence checked before body validation; unknown / cross-user id → `404` (never `403`, no id leak). `DELETE` → `204`.

### Row → response (`WebhookEndpoint`, all reads)

| Column | Field | Notes |
|---|---|---|
| `id` | `id` | |
| `provider` | `provider` | |
| `repo` | `repo` | |
| `project` | `project` | |
| `is_enabled` | `is_enabled` | boolean |
| `created_at` / `modified_at` | `created_at` / `modified_at` | normalized date-time |

`secret_encrypted` is **never** projected into a response (no `secret` field on `WebhookEndpoint`) — the secret is write-only (FR-009, SC-004).

## Delivery path — `POST /webhooks/git/{provider}` (PR2)

Public (`security: []`); no `c.get("userId")` — the target user comes from the registration. Ordered handling (FR-001..FR-007, FR-011):

1. **Provider** from the path. Not `github`/`gitlab` → `404` (FR-001).
2. **Raw body** read once via `c.req.arrayBuffer()` (bounded by the global 256 KB `bodyLimit`, which itself returns `413` for an oversized delivery before this handler runs — platform-inherited, out of scope); `JSON.parse` that same buffer. Unparseable → `400` (FR-007). *(Never `c.req.json()` then re-read — the HMAC needs the raw bytes; research D-3/D-10.)*
3. **Event** from the provider header (`X-GitHub-Event` / `X-Gitlab-Event`). A **missing or empty** header → `400` (the delivery names no event, FR-007). `ping` or any recognized non-`push` event (a present, non-empty header other than the push event — GitHub `push` / GitLab `Push Hook`) → `202` with zero counts (FR-007).
4. **Repo** from the payload (`repository.full_name` / `project.path_with_namespace`). If that field is **absent or empty** (the body cannot identify a repository) → `400` (FR-007). Otherwise **lookup** the enabled registration by `(provider, repo)` via `idx_webhook_endpoints_lookup`. None (or disabled) → `404` (FR-002).
5. **Verify** against `decryptToken(secret_encrypted, ENCRYPTION_KEY, 'webhook:'+id)`: GitHub `HMAC-SHA256(rawBody, secret)` vs `X-Hub-Signature-256` (constant-time); GitLab `X-Gitlab-Token` vs secret (constant-time). Mismatch → `401`, nothing written (FR-003).
6. **Map** each `push` commit to a `CommitInput` (research D-5 table), clamp to caps, omit unnormalizable fields; drop objects with no usable `hash` (counted in `skipped`); cap at 100 (`skipped` += remainder) (FR-004, FR-006).
7. **Write** the mapped commits under the registration's `user_id` + `project` in **one** `db.batch()` of the existing upsert — reusing the bulk write path, no correlation, `total_seconds` bound `null` when absent (FR-005, FR-011):

```ts
// pseudocode — reuses the bulk write path (src/routes/commits.ts, #147)
const stmts = mapped.map((v) => commitUpsertStmt(c.env.DB, reg.user_id, reg.project, v, v.total_seconds));
await c.env.DB.batch<CommitRow>(stmts);   // one round-trip; total_seconds absent for git payloads
return c.json({ data: { received, ingested: mapped.length, skipped, project: reg.project } }, 202);
```

**No correlation query, no heartbeat scan** (FR-005, FR-011): unlike the single endpoint (#135/#145), the receiver never reads heartbeats — an absent `total_seconds` is stored `null` (read path renders `"0 secs"`).

**Idempotency** (FR-005, SC-002): the upsert is idempotent on `(user_id, project, hash)`; a redelivered push or an overlapping range updates rows in place — no duplicates.

## Secret at rest (FR-009, research D-4)

The secret is stored via the existing `encryptToken` (AES-256-GCM, `ENCRYPTION_KEY`, per-row AAD `webhook:<id>`) — the same recoverable-secret pattern OAuth access/refresh tokens use — because HMAC verification needs the raw secret (a one-way hash cannot recompute an HMAC). It is decrypted only inside the receiver for verification, never returned by a read, never logged. No new binding: `ENCRYPTION_KEY` already exists for OAuth.

## Read path (unchanged, #107)

`GET .../commits` (paginated, `author`/`branch` filters) and `GET .../commits/{hash}` shape `commits` rows via the existing `rowToCommit`, defaulting a missing `author_date` to `created_at`. Webhook-ingested rows flow through unchanged (FR-012).

## Untouched

Webhook ingestion writes only `commits` (and, via the CRUD, `webhook_endpoints`). It does **not** modify `summaries`, `hourly_summaries`, or `user_projects` (FR-013) — commits are an independent series. The single/bulk commit endpoints (#135/#145/#147) are unchanged; the receiver reuses their upsert.
