# Tasks: Git-host webhook adapter

**Branch**: `146-git-webhook-adapter`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Generated**: 2026-07-10 · **Issue**: #146

## PR1 — Spec + Design

- [ ] **T-001**: Author `spec.md` (US1 push→commits, US2 registration CRUD, US3 reject unverified/unmapped/unsupported; FR-001..FR-015; edge cases; SC-001..SC-007).
- [ ] **T-002**: Author `plan.md` (Constitution Check; two sub-apps — public receiver + owner CRUD; reuse bulk upsert, no correlation; encrypted secret; PR1 = OpenAPI only, PR2 = migration + handlers).
- [ ] **T-003**: Author `research.md` (D-1 public `/webhooks/git/{provider}` repo-from-payload, D-2 github+gitlab adapter, D-3 HMAC/token verify constant-time over raw body, D-4 AES-GCM encrypted write-only secret, D-5 payload mapping clamp/best-effort, D-6 reuse bulk write no-correlation cap-100, D-7 202-ack response contract, D-8 `/ai/prices`-style CRUD, D-9 delivery resolution + multi-user, D-10 raw-body + CSRF wiring).
- [ ] **T-004**: Author `data-model.md` (NEW `webhook_endpoints` DDL [PR2 migration]; CRUD request/response mapping; delivery ordered handling; single `db.batch()` write; secret at rest; untouched aggregates).
- [ ] **T-005**: Author `quickstart.md` (scenarios A–K).
- [ ] **T-006**: Author `contracts/openapi-diff.md` (additive: 3 `webhooks/` path files, `WebhookEndpoint`/`WebhookEndpointInput` schemas, path registration, `git_webhooks` tag).
- [ ] **T-007**: Author `checklists/requirements.md`.
- [ ] **T-008**: Add `schemas/paths/webhooks/git-provider.yaml` — `post` (`receiveGitWebhook`): **`security: []`**; `{provider}` path param; documented header params (`X-GitHub-Event`/`X-Hub-Signature-256`/`X-Gitlab-Event`/`X-Gitlab-Token`); freeform JSON body (provider payload); responses `202` (ack `{ data: { received, ingested, skipped, project } }`) / `400` / `401` / `404`. No `401`-via-`Unauthorized` inheritance surprises — the `401` here is verification failure. Tag `git_webhooks`.
- [ ] **T-009**: Add `schemas/paths/webhooks/webhooks.yaml` — `get` (`listGitWebhooks`, `200 { data: WebhookEndpoint[] }`) + `post` (`createGitWebhook`, body `WebhookEndpointInput`, `201 { data: WebhookEndpoint }`, `400`, `401`, `409`). Add `schemas/paths/webhooks/webhook.yaml` — file-level `{webhook_id}` param + `get` (`getGitWebhook`, `200`/`401`/`404`), `patch` (`updateGitWebhook`, partial `WebhookEndpointInput`, `200`/`400`/`401`/`404`), `delete` (`deleteGitWebhook`, `204`/`401`/`404`). Tag `git_webhooks`.
- [ ] **T-010**: Add `schemas/components/schemas/WebhookEndpoint.yaml` (output: `id`, `provider`, `repo`, `project`, `is_enabled`, `created_at`, `modified_at` — **no `secret`**) and `schemas/components/schemas/WebhookEndpointInput.yaml` (input: `provider` enum `github`/`gitlab`, `repo` ≤255, `project` ≤255, `secret` required non-empty write-only, `is_enabled` optional).
- [ ] **T-011**: Register the three paths in `schemas/openapi.yaml` under a new `# --- webhooks ---` banner (`/webhooks/git/{provider}`, `/users/current/webhooks`, `/users/current/webhooks/{webhook_id}`); add a `git_webhooks` tag to the `tags:` list.
- [ ] **T-012**: Run `npm run lint:api`; `npm run generate` (expect additive `receiveGitWebhook`/`listGitWebhooks`/`createGitWebhook`/`getGitWebhook`/`updateGitWebhook`/`deleteGitWebhook` operations, the three new path members, the two new schemas, and the new tag — no other member/shape change); `npm run typecheck`. Review the `src/types/generated.ts` diff.
- [ ] **T-013**: Commit PR1 in SDD order (SpecKit + schemas, then regenerated types), push, open PR against `develop` referencing #146.

## PR2 — Implementation (after PR1 merges)

- [ ] **T-101**: `migrations/0008_git_webhook_endpoints.sql` + mirror in `src/db/schema.sql` — `webhook_endpoints` table + `idx_webhook_endpoints_user` + `idx_webhook_endpoints_lookup` (data-model DDL). Header comment referencing Issue #146.
- [ ] **T-102**: `src/utils/webhooks/store.ts` — registration store: `insertEndpoint`/`updateEndpoint`/`deleteEndpoint`/`listEndpoints`/`getEndpoint` (owner-scoped) + `lookupEndpoint(provider, repo)` (enabled only, for delivery) + encrypt-on-write / decrypt-on-verify via `encryptToken`/`decryptToken` (AAD `webhook:<id>`). Enforce `UNIQUE(user_id, provider, repo)` (duplicate → a typed error the route maps to `409`), immutable `provider`/`repo` on update.
- [ ] **T-103**: `src/utils/webhooks/providers.ts` — per-provider adapters: `detectEvent(headers)`, `verify(provider, rawBody, headers, secret)` (GitHub `HMAC-SHA256(rawBody, secret)` vs `X-Hub-Signature-256` via new `crypto.subtle` HMAC + existing `timingSafeEqual`; GitLab `X-Gitlab-Token` vs secret via `timingSafeEqual`), `extractRepo(provider, payload)`, `mapCommits(provider, payload)` → `CommitInput[]` (research D-5 mapping, clamp to caps, omit unnormalizable, drop no-hash). Pure — no D1 — so it unit-tests without a DB.
- [ ] **T-104**: `src/routes/webhooks.ts` — (a) owner CRUD `Hono<AuthEnv>` under `authMiddleware` mirroring `/ai/prices` (create/list/read/patch/delete; secret write-only; immutable provider/repo `400`; duplicate `409`; unknown/cross-user `404`; `401` before body); (b) public receiver `Hono<{ Bindings: Env }>` (no auth): raw-body read → parse → provider `404` → event (`ping`/non-push → `202` zero) → `extractRepo` → `lookupEndpoint` (none/disabled → `404`) → `verify` (fail → `401`) → `mapCommits` (cap 100, `skipped`) → one `db.batch()` of `commitUpsertStmt(db, reg.user_id, reg.project, v, v.total_seconds)` → `202 { data: {received,ingested,skipped,project} }`. Export/reuse `commitUpsertStmt`/`rowToCommit` from `commits.ts` (behavior-preserving). **No correlation query** (FR-005/FR-011).
- [ ] **T-105**: `src/index.ts` — mount the CRUD (authed, `/api/v1/users/current`) and the receiver (public, `/api/v1`); add the receiver path to the global CSRF exemption (next to `/api/v1/auth/link/verify/`, FR-014/research D-10).
- [ ] **T-106a**: Unit tests `tests/security/webhook-providers.test.ts` — verify: valid GitHub HMAC accepts, tampered body / wrong secret / missing signature reject; a whitespace change to the signed bytes fails (raw-body, not re-serialized); valid/invalid GitLab token; timing-safe path exercised. Mapping: GitHub/GitLab payload → `CommitInput[]` (fields, `ref` from top level, committer omitted for GitLab), clamp over-long `message`, omit bad date, drop no-`id` object.
- [ ] **T-106b**: Integration tests `tests/integration/webhooks.test.ts` — receiver: signed GitHub push → commits under mapped project + read-back "0 secs" (no correlation even with surrounding heartbeats); GitLab push; redelivery idempotent (one row); wrong signature `401` writes nothing; unmapped `404`; unsupported provider `404`; disabled registration `404`; `ping`/non-push `202` zero; cap 100 + `skipped`; project from registration not payload; cross-user isolation; aggregates untouched. CRUD: create→list→read→patch→delete, secret never in any response, immutable provider/repo `400`, duplicate `409`, unknown/cross-user `404`, `401` unauth.
- [ ] **T-107**: `npm run lint:api` (no drift) · `npm run typecheck` (zero errors) · `npm test` (full suite green incl. new unit + integration).
- [ ] **T-108**: Commit with `feat:` prefix, push, open PR against `develop` referencing PR1 and issue #146 (`Closes #146`). Note operator action: PR2 adds migration `0008` (apply at deploy) and relies on the existing `ENCRYPTION_KEY`.

## Dependencies

```
T-001 .. T-012 → T-013                   (PR1)
T-013 → T-101 .. T-108                    (PR2 after PR1 merge)
T-101 → T-102 → T-103 → T-104 → T-105 → T-106 → T-107 → T-108
```

## Out of scope

- **Providers beyond GitHub/GitLab** (Bitbucket, Gitea, …) — the adapter layer (research D-2) makes them additive; a future issue per provider.
- **Multi-user delivery disambiguation** (per-registration receiver URLs/tokens) — deferred to the multi-user foundation (#148); delivery resolution here is scoped to single-user mode (research D-9).
- **Server-side `total_seconds` correlation for webhook commits** — the webhook reuses bulk's correlation-free path (research D-6); the shared-window batch correlation deferred by #147 remains the future enhancement.
- **Storing the raw push payload / non-commit events** (issues, PRs, releases) — only `push` commits are ingested; other events are acknowledged and ignored.
- **A management UI** for registrations (dashboard forms) — the CRUD API is the surface here; a UI is a possible follow-up.
- Any change to `summaries` / `hourly_summaries` / `user_projects`, the read endpoints, or the single/bulk commit endpoints (#135/#145/#147) — untouched.
