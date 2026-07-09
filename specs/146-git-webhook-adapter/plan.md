# Implementation Plan: Git-host webhook adapter for commit ingestion

**Branch**: `146-git-webhook-adapter` | **Date**: 2026-07-10 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/146-git-webhook-adapter/spec.md`

## Summary

Add a public git-host webhook receiver, `POST /webhooks/git/{provider}` (`security: []`), that verifies a per-repository signature/token, resolves a stored **registration** (repo → project mapping + secret), maps the provider's `push` payload to `CommitInput`s, and fans them out through the **bulk** commit write path (one `db.batch()` of the existing `(user_id, project, hash)` upsert, #147) — **no** heartbeat correlation (payloads carry no coding time; per-commit correlation over a push breaks the Workers budget). Plus an owner-authenticated registration CRUD (`/users/current/webhooks` + `/{webhook_id}`) mirroring `/ai/prices`, with a write-only secret stored AES-256-GCM encrypted (the OAuth-token precedent). Supported providers: `github` (HMAC-SHA256 body signature) and `gitlab` (token header).

**PR1 (this PR)**: SpecKit artifacts + OpenAPI (new `webhooks/` path files: the public receiver + the CRUD collection/item; new `WebhookEndpoint` / `WebhookEndpointInput` schemas; a `git_webhooks` tag) + regenerated types. **No route/business logic, no migration.**

**PR2 (after PR1 merges)**: the `webhook_endpoints` D1 table (migration `0008` + `schema.sql`), the owner CRUD handlers, the public receiver + per-provider adapters (GitHub/GitLab verification + payload mapping) reusing the bulk upsert, the CSRF exemption + raw-body read, and unit + integration tests.

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers)
**Primary Dependencies**: Hono >= 4.9.7; existing `validateCommitInput` + the bulk upsert (`commitUpsertStmt`/`UPSERT_SQL`/`rowToCommit`, `src/routes/commits.ts`); existing crypto (`timingSafeEqual`, `encryptToken`/`decryptToken`, `src/utils/crypto.ts`); Web Crypto HMAC (`crypto.subtle.importKey`/`sign`)
**Storage**: D1 — NEW `webhook_endpoints` (registration + encrypted secret; PR2 migration) + existing `commits` (one `db.batch()` upsert, no schema change)
**Testing**: Vitest + workers pool — unit tests for per-provider signature verification (valid/invalid HMAC, valid/invalid GitLab token, timing-safe compare) and payload → `CommitInput[]` mapping (GitHub/GitLab, clamping, skip-on-no-hash); integration tests for the receiver (signed push → commits under mapped project, redelivery idempotent, wrong signature 401, unmapped 404, unsupported provider 404, disabled 404, ping/non-push 202 zero, no-correlation "0 secs", cap 100 + skipped) and the CRUD (create/list/read/patch/delete, secret write-only, immutable provider/repo, duplicate 409, unknown/cross-user 404, 401 unauth)
**Performance Goals**: <10ms CPU on the receiver — one indexed `(provider, repo)` lookup, one decrypt + one signature check, one `db.batch()`; no per-commit round-trip, no heartbeat scan (FR-011)
**Constraints**: reuse the bulk upsert unchanged; D1 bulk write via a single `db.batch()`; secrets encrypted at rest, never in URLs/logs, write-only (`docs/implementation-boundaries.md`); original payload parsing, no third-party source/fixtures; `WakaTime` only as `WakaTime-compatible` in docs

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | OpenAPI (receiver + CRUD + schemas) lands first (PR1); handlers + migration follow in PR2. Types regenerated, never hand-edited. |
| II. Cloudflare-Native | PASS | Receiver: one indexed lookup + one `db.batch()`, no per-commit query, no heartbeat scan; bounded body via the global `bodyLimit`. Secret decrypt is one AES-GCM op. |
| III. Type Safety | PASS | Handlers use `components["schemas"]["WebhookEndpoint"]`/`["WebhookEndpointInput"]`/`["CommitInput"]` from generated types; reuse `ValidatedCommit`. |
| IV. Legal/Trademark | PASS | Original receiver + original payload parsing of documented public fields; `github`/`gitlab` are integration identifiers (as in `/auth/{provider}`), not branding; no third-party source/fixtures; `WakaTime` only `WakaTime-compatible` in docs. |
| V. Simplicity First | PASS | Reuses the bulk upsert (no new write path, no correlation), the `/ai/prices` CRUD shape, and the OAuth `*_encrypted` secret pattern. One new table, two providers behind a thin adapter. |

## Project Structure

### Documentation (this feature)

```text
specs/146-git-webhook-adapter/
├── plan.md
├── spec.md
├── research.md
├── data-model.md
├── quickstart.md
├── tasks.md
├── contracts/
│   └── openapi-diff.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
# PR1
schemas/paths/webhooks/git-provider.yaml        # NEW: post (receiveGitWebhook) — public, security: []
schemas/paths/webhooks/webhooks.yaml            # NEW: get (listGitWebhooks) + post (createGitWebhook)
schemas/paths/webhooks/webhook.yaml             # NEW: get/patch/delete ({webhook_id} item)
schemas/components/schemas/WebhookEndpoint.yaml       # NEW: output (no secret)
schemas/components/schemas/WebhookEndpointInput.yaml  # NEW: input (secret required on create)
schemas/openapi.yaml                            # CHANGE: register the 3 paths under a new # --- webhooks --- banner; add git_webhooks tag
src/types/generated.ts                          # REGENERATED (npm run generate)

# PR2 (after PR1 merges)
migrations/0008_git_webhook_endpoints.sql       # NEW: webhook_endpoints table + indexes
src/db/schema.sql                               # CHANGE: mirror the new table
src/routes/webhooks.ts                          # NEW: owner CRUD (authed) + public receiver sub-app
src/utils/webhooks/providers.ts                 # NEW: per-provider adapters (event detect, verify, payload → CommitInput[])
src/utils/webhooks/store.ts                     # NEW: registration insert/update/delete/list/lookup + encrypt/decrypt secret
src/routes/commits.ts                           # CHANGE (if needed): export commitUpsertStmt/rowToCommit for reuse
src/index.ts                                    # CHANGE: mount the receiver (public) + CRUD (authed); add the CSRF path exemption
```

**Structure Decision**: Two sub-apps. The **CRUD** is a `Hono<AuthEnv>` mounted at `/api/v1/users/current` with `authMiddleware` (mirrors `ai`/`commits`). The **receiver** is a `Hono<{ Bindings: Env }>` mounted at `/api/v1` with **no** auth (mirrors `meta`/`cardsPublic`), and its route is added to the global CSRF exemption. The receiver reads the raw body once (for HMAC), `JSON.parse`s that buffer, dispatches on `{provider}` to a per-provider adapter (verify + map), resolves the registration from `(provider, repo)`, then reuses the bulk upsert. Secrets go through `encryptToken`/`decryptToken` (AES-256-GCM, `ENCRYPTION_KEY`). No new binding.

## Phases

- **PR1 — Spec + Design (this PR)**: author the SpecKit set; add the three `webhooks/` path files (public receiver + CRUD collection/item), the `WebhookEndpoint`/`WebhookEndpointInput` schemas, register the paths + tag in `openapi.yaml`; `npm run lint:api`; `npm run generate`; `npm run typecheck`. No handler, no migration.
- **PR2 — Implementation**: `webhook_endpoints` migration + schema mirror; owner CRUD handlers (encrypt secret, write-only reads, immutable provider/repo, duplicate 409, 404-not-403); public receiver + GitHub/GitLab adapters (raw-body HMAC / token verify, payload map, clamp, best-effort) reusing the bulk `db.batch()` upsert; CSRF exemption + mount wiring; unit + integration tests; `npm test` green; open PR referencing #146 and PR1 (`Closes #146`).

## Risks & Mitigations

- **Secret leakage** → secret is write-only (never returned/logged) and AES-256-GCM encrypted at rest (FR-009, research D-4); no secret in the URL (research D-1). Tests assert no `secret` field in any response.
- **Verifying a re-serialized body** → HMAC the RAW request bytes, parse that same buffer; never `c.req.json()` then re-serialize (research D-3, D-10). Unit test signs a fixed byte string and asserts a whitespace change fails.
- **CSRF blocks the public POST** → add the receiver to the global CSRF exemption, like the email-verify POST (FR-014, research D-10). Integration test posts with no `Origin`/`Authorization` and expects the handler (not a 403).
- **Per-commit correlation blowing the request budget** → reuse the bulk write path; no correlation (FR-005/FR-011, research D-6). Receiver does one `db.batch()`, no heartbeat scan.
- **A host disabling the hook over one bad commit** → best-effort ingest + `skipped` count, always 2xx on a verified delivery (FR-006/FR-007, research D-7); not all-or-nothing.
- **Timing oracle on secret/signature** → constant-time compare via `timingSafeEqual` (research D-3).
- **Multi-user delivery ambiguity** → `(provider, repo)` resolution is scoped to single-user mode; per-registration URLs deferred to #148 (research D-9), recorded not dropped.
- **Type drift** → request/response types are generated from the new `WebhookEndpoint`/`WebhookEndpointInput` + existing `CommitInput`; the generate diff is reviewed to confirm only the additive operations/paths/schemas + the new tag.
