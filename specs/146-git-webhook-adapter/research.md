# Research & Decisions: Git-host webhook adapter

**Branch**: `146-git-webhook-adapter` | **Date**: 2026-07-10

Documented decisions that shape the contract. Each records the choice, the alternatives, and why. Where an existing convention (the commit endpoints #135/#147, the `/ai/prices` owner CRUD, the OAuth `*_encrypted` secret pattern) already fixed a shape, this feature follows it rather than re-litigating it.

> **On clarifications**: this is an unattended docs stage. Where a maintainer would normally be asked, the most conservative reasonable choice was made and recorded here (D-1..D-10), preferring consistency with existing endpoints, the Cloudflare per-request budget, and the security posture of the codebase (secrets encrypted at rest, never in URLs/logs).

## D-1: Public receiver — `POST /webhooks/git/{provider}`, repo resolved from the payload

**Decision**: `POST /webhooks/git/{provider}` is a **public** operation (`security: []`). It does not take a per-repo token in the URL; instead it reads the repository identity from the delivery payload (GitHub `repository.full_name`, GitLab `project.path_with_namespace`) and resolves the stored registration from `(provider, repo)`.

**Why**: This is the exact shape the issue fixes. Keeping the URL free of any secret honours `docs/implementation-boundaries.md` ("Public URLs do not expose secrets") — a token in the path would leak in access logs, `Referer`, and proxy caches. The provider is a small path enum so the router and the adapter layer can dispatch on it, mirroring the existing `/auth/{provider}` OAuth surface. `security: []` overrides the global four-scheme auth requirement (`apiKey`/`bearer`/`apiKeyQuery`/`sessionCookie`), exactly as the public `cards`/`badges` endpoints (#160) do.

**Alternatives rejected**:
- *Per-repo URL token* (`/webhooks/git/{provider}/{token}`): avoids parsing the body before knowing the secret, but puts a secret in a public URL (boundary violation) and changes the path shape the issue specifies. Rejected.
- *Single generic `/webhooks/git` with the provider in a header*: less discoverable and diverges from `/auth/{provider}`. Rejected.

**Consequence (accepted)**: because the secret is keyed by `(provider, repo)` and repo comes from the body, the handler must parse the (bounded, ≤256 KB per the global `bodyLimit`) untrusted JSON to find the repository *before* it can select the secret and verify the signature. This is the standard multi-repo receiver pattern; the body is size-bounded and only the repository identity is trusted pre-verification — nothing is written until the signature checks out (FR-003).

## D-2: Provider support — `github` and `gitlab`, behind a small adapter layer

**Decision**: Support two providers now: `github` (`push` event) and `gitlab` (`Push Hook` event). Model each as a small adapter (event detection + signature verification + payload → `CommitInput[]` mapping) so a third provider is additive. Any other `{provider}` returns `404`.

**Why**: The issue names both, and the endpoint is `{provider}`-parameterized — a single-provider receiver would make the path segment meaningless. GitHub and GitLab are the two dominant hosts and use two *different* authentication styles (HMAC body signature vs token header), so covering both exercises the general shape rather than a special case. A per-provider adapter keeps the differences (header names, event names, payload field paths, verification method) isolated and testable.

**Alternatives rejected**:
- *GitHub only*: under-delivers and leaves the `{provider}` enum a single value. Rejected.
- *GitHub + GitLab + Bitbucket/Gitea now*: more providers multiply parsing/verification surface without issue demand. **Deferred** — the adapter layer makes them additive; recorded here and in tasks "Out of scope", not silently dropped.

## D-3: Verification — GitHub HMAC-SHA256 over the raw body; GitLab token header; constant-time

**Decision**: Verify authenticity against the registration secret before any write.
- **GitHub**: recompute `HMAC-SHA256(raw_request_body, secret)` and compare it constant-time to `X-Hub-Signature-256: sha256=<hex>`.
- **GitLab**: compare the `X-Gitlab-Token` header constant-time to the secret (GitLab does not sign the body by default).

Read the **raw bytes** for the HMAC (via `c.req.arrayBuffer()` / `c.req.raw`) and `JSON.parse` that same buffer — never re-read the stream, and never HMAC a re-serialized body (JSON round-tripping would change the bytes and break the signature). Reuse the existing constant-time comparator `timingSafeEqual` (`src/utils/crypto.ts`); add the HMAC via `crypto.subtle.importKey("raw", …, {name:"HMAC", hash:"SHA-256"}, …)` + `crypto.subtle.sign` (Web Crypto, Workers-native — the file already imports raw keys for AES).

**Why**: These are the documented, public verification mechanisms for the two hosts. HMAC over the raw body is the only correct way to verify a GitHub signature; a constant-time compare avoids a timing oracle on the secret. This is the codebase's first HMAC usage, but the crypto primitives (`crypto.subtle`, `timingSafeEqual`) already exist.

**Alternatives rejected**:
- *Parse then re-serialize for the HMAC*: byte-fragile — whitespace/key-order differences break the signature. Rejected; HMAC the raw buffer.
- *Plain `===` on the token/signature*: leaks a timing side-channel. Rejected; use `timingSafeEqual`.

## D-4: Secret at rest — AES-256-GCM encrypted (recoverable), never hash, never plaintext, write-only

**Decision**: Store the registration secret **encrypted at rest** with AES-256-GCM via the existing `ENCRYPTION_KEY` (the same helper and pattern OAuth access/refresh tokens use — `encryptToken`/`decryptToken` with a per-row `context` as AAD, e.g. `webhook:<id>`). The secret is **write-only** in the API: supplied on create/update, never returned by any read, never logged.

**Why**: HMAC verification (D-3, GitHub) needs the *raw* secret to recompute the signature, so a one-way SHA-256 hash (the API-key / session-token pattern) will not work — the secret must be recoverable. The codebase already draws exactly this line: irreversible secrets (API keys, session tokens, verification tokens) are SHA-256-hashed; secrets that must be *replayed* (OAuth provider tokens) are AES-256-GCM encrypted. A webhook secret is a replayed secret, so it follows the OAuth precedent. Encrypting (not plaintext) keeps a DB dump from exposing every hook secret. No new binding: `ENCRYPTION_KEY` already exists for OAuth.

**Alternatives rejected**:
- *SHA-256 hash*: cannot recompute an HMAC from a hash → breaks GitHub verification. (For GitLab-only, a hash of the token would suffice, but a single storage scheme across providers is simpler and future-proof.) Rejected.
- *Plaintext column*: a DB compromise leaks every secret; worse than the existing precedent. Rejected.
- *Server-generated secret returned once* (API-key style): viable, but the owner must paste the same secret into the git host's webhook config, so letting the owner **supply** it (and set it identically in both places) is the simpler mental model. Owner-supplied secret on create; still write-only and encrypted.

## D-5: Payload mapping — original parsing of documented fields, clamped and best-effort

**Decision**: Map each provider's `push` commit objects to `CommitInput` using only documented public fields, parsed originally:

| `CommitInput` | GitHub `push` | GitLab `Push Hook` |
|---|---|---|
| `hash` | `commits[].id` | `commits[].id` |
| `message` | `commits[].message` | `commits[].message` |
| `author_name` / `author_email` | `commits[].author.name` / `.email` | `commits[].author.name` / `.email` |
| `committer_name` / `committer_email` | `commits[].committer.name` / `.email` | *(omitted — not in payload)* |
| `author_date` | `commits[].timestamp` | `commits[].timestamp` |
| `url` | `commits[].url` | `commits[].url` |
| `ref` | top-level `ref` (e.g. `refs/heads/main`) | top-level `ref` |
| `total_seconds` | *(none — omitted)* | *(none — omitted)* |
| repo (→ registration) | `repository.full_name` | `project.path_with_namespace` |

Clamp mapped fields to the `CommitInput` length limits (e.g. truncate an over-long `message` to 4096) and omit any field that cannot be normalized (an unparseable `timestamp` → omit `author_date`, which the read path backfills from `created_at`). A commit object without a usable `id`/`hash` is skipped and counted in `skipped`; every commit with a valid identifier ingests.

**Why**: These field names are public API facts (documented webhook payloads / platform docs), used originally — no third-party source or fixture copied (`docs/implementation-boundaries.md`). Clamping-and-omitting rather than rejecting means a real commit is never lost to a strict validator (a squash merge with a long body, an odd author string): the goal of a receiver is to ingest what the host sends, not to police it.

**Alternatives rejected**:
- *Reject a delivery on any unmappable field*: loses real commits and (if it returns non-2xx) wedges the host into retry/disable loops. Rejected in favour of best-effort + `skipped` count.
- *Store the raw payload*: out of scope; commits are the product, the raw push is not.

## D-6: Reuse the bulk write path; NO heartbeat correlation; cap 100 (why #146 follows #147)

**Decision**: Fan the mapped commits out through the **bulk** write path — one `db.batch()` of the existing `(user_id, project, hash)` upsert (`commitUpsertStmt`, `UPSERT_SQL`, `rowToCommit`) — capped at 100 per delivery, and **without** heartbeat correlation. `total_seconds` is whatever the payload carries (git payloads carry none → stored absent, read path renders `"0 secs"`).

**Why**: A push is inherently multi-commit, so this is `commits.bulk` (#147) with a provider-facing front-end — the same reason bulk exists. Per-commit correlation (#145) is O(N) extra D1 reads + heartbeat scans over a bounded window; doing it per element in a push would blow the Workers per-request CPU (~10ms) and subrequest budget that `docs/cloudflare-constraints.md` binds (research D-3 in #147 quantifies this: ~200 subrequests + hundreds of thousands of row-reads for a 100-commit batch). The webhook therefore reuses bulk's correlation-free single-`db.batch()` write verbatim. **This dependency is why #146 sequences after #147.** Cap 100 = the bulk cap; git hosts already truncate push `commits[]` (GitHub ~20), so 100 is comfortably above real deliveries — a delivery over the cap ingests the first 100 and reports the rest in `skipped` (no silent truncation).

**Alternatives rejected**:
- *Per-commit correlation (parity with the single endpoint)*: breaks the per-request budget (above). Rejected — the same call bulk made.
- *Shared-window batch correlation*: the deferred #147 enhancement; still out of scope here (a webhook is exactly the case that motivates deferring it). Recorded, not dropped.

## D-7: Response contract — `202` ack with counts; best-effort, not all-or-nothing

**Decision**: A handled delivery returns `202` with `{ data: { received, ingested, skipped, project } }`. A `ping` or a recognized non-`push` event returns `202` with zero counts. Verification failure → `401`; unmapped repo / unsupported provider / disabled registration → `404`; unparseable body → `400`. Ingestion is best-effort (D-5/D-6), not all-or-nothing.

**Why**: Git hosts treat any 2xx as success and *disable* a hook after repeated non-2xx; an all-or-nothing 4xx over one odd commit would take a whole repository's ingestion down. `202 Accepted` with counts is honest (the caller/tester sees `received`/`ingested`/`skipped`) and host-friendly. `ping`/non-`push` acknowledged (not errored) so setup and unrelated events don't trip the host. `404` for both "no such provider" and "no registration/disabled" avoids revealing which repositories are configured (it also can't verify a signature it has no secret for). This deliberately differs from `commits.bulk`'s all-or-nothing 400 (#147 D-2): bulk is a first-party API where the caller wants a hard error; a webhook is a machine-to-machine delivery that must ack.

**Alternatives rejected**:
- *All-or-nothing 4xx on a bad commit* (bulk parity): wedges the host into retry/disable. Rejected.
- *`200`/`204` with no body*: fine for the host but gives manual tests / the CRUD owner nothing to confirm ingestion; the small ack body costs nothing. `202` chosen.

## D-8: Owner registration CRUD — mirror `/ai/prices`

**Decision**: Manage registrations with an owner-authenticated CRUD under `/users/current/webhooks`: `POST` (create) + `GET` (list) on the collection, `GET`/`PATCH`/`DELETE` on `/users/current/webhooks/{webhook_id}`. It mirrors the `/ai/prices` owner CRUD: authenticated (`401` unauth), `user_id`-scoped, `404`-not-`403` for unknown/cross-user ids, no id leak. `provider` + `repo` form the natural key and are **immutable** on `PATCH` (like `ai_model_prices`' immutable `provider`/`model`/`effective_from`); `project`, `secret`, `is_enabled` are mutable. `(user_id, provider, repo)` is unique; a duplicate create → `409`.

**Why**: The receiver is inert without registrations; they need a management surface, and the closest existing owner-config CRUD is `/ai/prices` (#200) — reuse its shape and its authz/404 discipline verbatim so behavior and review are familiar. Immutable natural key avoids a registration silently "moving" to a different repo.

**Alternatives rejected**:
- *No CRUD; seed rows out-of-band*: untestable and unusable; the "new config/table" the issue calls for needs an owner surface. Rejected.
- *Full `PUT` replace*: `PATCH` (the item convention across the API) is enough and keeps the immutable key enforceable field-by-field. Rejected.

## D-9: Delivery resolution and multi-user

**Decision**: The delivery lookup matches `(provider, repo)`. In single-user mode (`INSTANCE_MODE=single`, the default) there is exactly one owner, so `(provider, repo)` resolves unambiguously to one registration (and thus one `user_id`, `project`, and secret). The table stores `user_id` on every row (for cross-user isolation and future multi-user), and `UNIQUE(user_id, provider, repo)` allows two users to each register the same public repo.

**Why**: A public delivery carries no authenticated user, so the target user must come from the registration. In single-user mode the mapping is 1:1. Multi-user would make `(provider, repo)` non-unique across users (two owners registering `acme/widgets`); disambiguating a delivery then needs a per-registration signal in the URL (a distinct receiver path/token per registration). That is a multi-user concern.

**Alternatives rejected**:
- *Global `UNIQUE(provider, repo)`*: would forbid two users mapping the same public repo, breaking the multi-user model the schema is designed for. Rejected — scope resolution to single-user now, defer multi-user disambiguation to #148 (recorded, not dropped).

## D-10: Public-POST wiring — raw body + CSRF exemption (binds PR2)

**Decision**: Mount the receiver as a public sub-app (typed `Hono<{ Bindings: Env }>`, no `authMiddleware`), like `meta`/`cardsPublic`. Two wiring facts bind PR2: (1) the handler reads the raw request bytes once (for the HMAC) and `JSON.parse`s that buffer — it does not call `c.req.json()` and then try to re-read; (2) the route MUST be added to the global CSRF exemption list in `src/index.ts` (the guard today lets through requests with an `Authorization` header or the `/api/v1/auth/link/verify/` path; a git-host POST has neither an `Authorization` header nor a same-origin `Origin`, so without an exemption CSRF returns `403` before the handler runs). The existing public email-verify POST is the precedent for a public, non-`Authorization` POST that opts out of CSRF.

**Why**: These are non-obvious Workers/Hono facts that a naive PR2 would trip on (double body read; a silent CSRF `403`). Recording them here and in `plan.md`/`data-model.md` keeps PR2 from re-discovering them.

**Alternatives rejected**: none — these are constraints of the existing middleware stack, not choices.
