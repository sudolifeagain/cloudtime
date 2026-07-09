# Feature Specification: Git-host webhook adapter for commit ingestion

**Feature Branch**: `146-git-webhook-adapter`
**Created**: 2026-07-10
**Status**: Draft
**Input**: Commit ingestion exists as a first-party, API-key endpoint (`POST /users/current/projects/{project}/commits`, #135) and a bulk sibling (`commits.bulk`, #147). A git host (GitHub/GitLab) push event cannot call those directly — it authenticates with a per-repo signature, not an API key, and it carries many commits at once. Add a public webhook receiver that verifies the provider signature, maps the repository to a CloudTime `project`, and fans each commit into the existing ingestion upsert. Issue #146.

## Background

Commit ingestion (#135, #147) is first-party: the caller holds the user's API key and names the `project` in the URL. A git-host webhook is a different shape entirely — the git host (GitHub, GitLab, …) POSTs a push payload to a URL we publish, authenticates the delivery with a **per-repository shared secret** (an HMAC signature for GitHub, a token header for GitLab), and identifies the repository inside the payload rather than in the URL. It cannot present an API key, and it delivers a whole push (many commits) in one request.

This feature adds two surfaces:

1. **A public webhook receiver** — `POST /webhooks/git/{provider}` (`security: []`) — that reads the raw delivery, resolves the repository → a stored **registration** (repo → project mapping + secret), verifies the delivery's signature/token against that registration's secret, maps the provider's `push` payload to `CommitInput`s, and fans them out to the existing idempotent commit upsert.
2. **An owner-authenticated registration CRUD** — `POST/GET /users/current/webhooks` and `GET/PATCH/DELETE /users/current/webhooks/{webhook_id}` — so the owner can register a repository (provider + repo + target project + secret), list, update, and remove registrations. The secret is write-only.

**Reuse of bulk ingestion (#147):** a push carries many commits, so the receiver fans them out through the **bulk** write path — one `db.batch()` of the existing `(user_id, project, hash)` upsert — and, exactly like `commits.bulk` (research D-3 there), does **not** correlate heartbeats to derive `total_seconds`. Per-commit correlation over a push would issue O(N) extra D1 reads and heartbeat scans, past the Workers per-request budget that `docs/cloudflare-constraints.md` binds. Git push payloads carry no coding-time field anyway, so an ingested commit's `total_seconds` is stored absent and the read path renders `"0 secs"`. This is why #146 sequences after #147.

**Provider hygiene:** payload parsing uses only documented, public webhook fields, implemented originally. No third-party service source, payload fixtures, or documentation text is copied (`docs/implementation-boundaries.md`). The provider identifiers `github` / `gitlab` are factual integration targets, consistent with the existing `/auth/{provider}` OAuth surface — not third-party branding.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A push lands as commits under the mapped project (Priority: P1)

As an owner who has registered a repository, when I push to that repository the git host delivers the push to CloudTime, and the commits appear under the mapped project — no API key involved.

**Why this priority**: This is the feature — it turns a git-host push into ingested commits automatically, without the developer wiring an API key into CI or a local hook.

**Independent Test**: With a registration mapping `github` repo `acme/widgets` → project `widgets` (secret `s3cr3t`), `POST /webhooks/git/github` with a valid GitHub `push` payload and a matching `X-Hub-Signature-256` returns `202` with `{ data: { received, ingested, skipped, project: "widgets" } }`; a subsequent `GET /users/current/projects/widgets/commits` lists each pushed commit, and `GET .../commits/{hash}` returns each one.

**Acceptance Scenarios**:

1. **Given** a registration `(github, acme/widgets) → widgets`, **When** a signed GitHub `push` with three commits is delivered, **Then** `202` and all three are stored under the registration's `user_id` and `project` (`widgets`), each mapped from the payload (`id`→`hash`, `message`, `author`/`committer` name+email, `timestamp`→`author_date`, `url`, the push `ref`→`ref`).
2. **Given** the delivered commits, **When** listing/reading the project's commits, **Then** all appear (newest-first by `author_date`) with `total_seconds` absent and `human_readable_total` `"0 secs"` — the webhook path does not correlate heartbeats.
3. **Given** the git host redelivers the same push (retry) or a later push whose range overlaps, **When** delivered, **Then** re-sent hashes update in place (idempotent on `(user_id, project, hash)`), never duplicating.
4. **Given** a GitLab registration and a signed GitLab `Push Hook`, **When** delivered, **Then** the same mapping applies from the GitLab payload (`project.path_with_namespace`→repo, `commits[].id`→`hash`, etc.).

---

### User Story 2 - Register and manage repository mappings (Priority: P1)

As the owner, I register a repository with its provider, its target CloudTime project, and the shared secret; I can list, update, and delete my registrations. The secret is write-only.

**Why this priority**: The receiver is inert without a registration — it needs the repo→project mapping and the secret to verify a delivery. This is how those rows come to exist.

**Independent Test**: `POST /users/current/webhooks` with `{ provider: "github", repo: "acme/widgets", project: "widgets", secret: "s3cr3t" }` returns `201` with the stored registration (no `secret` field); `GET /users/current/webhooks` lists it; `PATCH .../{id}` changes `project`/`is_enabled`; `DELETE .../{id}` removes it; a follow-up delivery for that repo then 404s.

**Acceptance Scenarios**:

1. **Given** a create body with `provider` (a supported enum), non-empty `repo`, `project`, and `secret`, **When** posted, **Then** `201` with the stored `WebhookEndpoint` (id, provider, repo, project, `is_enabled`, timestamps) and **no** `secret` echoed.
2. **Given** an existing registration, **When** `GET /users/current/webhooks`, **Then** it is listed (secrets never appear); `GET .../{id}` returns it; an unknown or another user's id returns `404`.
3. **Given** an existing registration, **When** `PATCH .../{id}` sets `project`, `secret`, or `is_enabled`, **Then** those change; `provider` and `repo` are immutable (an attempt to change them returns `400`).
4. **Given** an existing registration, **When** `DELETE .../{id}`, **Then** `204`, and a subsequent delivery for that repo returns `404` (no registration).
5. **Given** a create body missing `secret`, or with an unsupported `provider`, or a `repo` already registered for this user+provider, **When** posted, **Then** `400` (validation) or `409`/`400` (duplicate) as specified, and nothing is written.

---

### User Story 3 - Unverified, unmapped, and unsupported deliveries are rejected safely (Priority: P1)

As the owner, I need deliveries that fail signature verification, name an unregistered repository, or target an unsupported provider to be rejected without writing anything and without leaking whether a repository is configured.

**Why this priority**: The receiver is public (`security: []`). Its only authentication is the per-repo signature; getting rejection right is the whole security story.

**Independent Test**: For a registered repo, `POST /webhooks/git/github` with a wrong `X-Hub-Signature-256` returns `401` and writes nothing; a payload for an unregistered repo returns `404`; `POST /webhooks/git/bitbucket` (unsupported) returns `404`; a body that is not parseable returns `400`.

**Acceptance Scenarios**:

1. **Given** a registered repo, **When** the delivery's signature/token does not match the registration secret, **Then** `401` and nothing is written.
2. **Given** a payload naming a repository with no registration, **When** delivered, **Then** `404` and nothing is written.
3. **Given** an unsupported `{provider}` path segment, **When** delivered, **Then** `404`.
4. **Given** a body that is not parseable JSON (or lacks the fields needed to identify the repository/event), **When** delivered, **Then** `400`, nothing written.
5. **Given** a registration disabled via `is_enabled = false`, **When** a delivery for its repo arrives, **Then** it is treated as unregistered — `404`, nothing written.

### Edge Cases

- **Provider handshake / non-push events**: GitHub sends a `ping` on setup and may send events other than `push`. A recognized non-`push` event (including `ping`) is acknowledged with `202` and zero counts (`{ received: 0, ingested: 0, skipped: 0 }`) — accepted, nothing ingested — so the host does not disable the hook.
- **Many commits in one push**: capped at 100 ingested per delivery (the bulk cap, #147). Git hosts already truncate push `commits[]` (GitHub ~20); if a delivery somehow carries more than 100 the first 100 are ingested and the remainder counted in `skipped` (never silently dropped).
- **A single malformed commit object**: the delivery is best-effort — a commit object without a usable `hash` is skipped and counted in `skipped`; the remaining commits still ingest, and the delivery still returns `202`. A verified delivery is acknowledged, never wedged into host-retry loops over one bad element.
- **Long/odd fields**: the adapter clamps mapped fields to the `CommitInput` length limits (e.g. truncates an over-long `message`) and omits any field it cannot normalize (e.g. an unparseable date → omit `author_date`, which the read path backfills from `created_at`), so a well-formed commit is never lost to a strict validator.
- **`project` source**: commits land under the **registration's** mapped `project`, never a value from the payload or the URL.
- **No `total_seconds`**: git payloads carry no coding time; ingested commits store `total_seconds` absent (`"0 secs"`), with no heartbeat correlation (contrast the single endpoint #135/#145).
- **Secret handling**: the secret is write-only — supplied on create/update, never returned by any read, never logged. It is stored encrypted at rest (needed in raw form to recompute an HMAC), not as a bare hash and not in plaintext.
- **CSRF**: the receiver is a cross-origin POST with no `Authorization` header and no same-origin `Origin`; it must be exempt from the global CSRF guard (PR2 wiring, FR-014), like the existing public email-verify POST.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose `POST /webhooks/git/{provider}` as a **public** operation (`security: []`, no API key / session). Supported `{provider}` values are `github` and `gitlab`; any other value MUST return `404`.
- **FR-002**: The receiver MUST resolve the delivery's target **registration** from `(provider, repo)`, where `repo` is read from the documented payload (GitHub `repository.full_name`; GitLab `project.path_with_namespace`). If no enabled registration matches, the receiver MUST return `404` and write nothing.
- **FR-003**: The receiver MUST verify the delivery's authenticity against the registration secret **before** writing anything: for `github`, recompute `HMAC-SHA256(raw_request_body, secret)` and compare it constant-time to the `X-Hub-Signature-256` header (`sha256=<hex>`); for `gitlab`, compare the `X-Gitlab-Token` header constant-time to the secret. A missing or non-matching signature/token MUST return `401` and write nothing.
- **FR-004**: On a verified `push` event the receiver MUST parse the provider payload — using only documented public fields, implemented originally — and map each commit to a `CommitInput` (`id`→`hash`, `message`, `author.name`/`author.email`→`author_name`/`author_email`, `committer.name`/`committer.email`→`committer_name`/`committer_email` when present, `timestamp`→`author_date`, `url`→`url`, and the push top-level `ref`→each commit's `ref`).
- **FR-005**: The receiver MUST persist the mapped commits under the registration's `user_id` and mapped `project` via the existing idempotent `(user_id, project, hash)` upsert, in a **single** `db.batch()` (reusing the bulk ingestion write path, #147). It MUST NOT correlate heartbeats to derive `total_seconds` — payloads carry none, so `total_seconds` is stored absent (read path renders `"0 secs"`).
- **FR-006**: Ingestion MUST be capped at 100 commits per delivery (the bulk cap, #147); a delivery carrying more ingests the first 100 and counts the remainder in `skipped`. Ingestion MUST be best-effort per commit: a commit object without a usable `hash` is skipped and counted in `skipped`; other commits still ingest. Mapped fields MUST be clamped to the `CommitInput` length limits and unnormalizable fields omitted, so any commit with a valid identifier is ingested.
- **FR-007**: On a handled delivery the receiver MUST return `202` with `{ data: { received, ingested, skipped, project } }` (a `ping` or non-`push` recognized event returns `202` with zero counts). An unparseable body, or one lacking the fields to identify the repository/event, MUST return `400`.
- **FR-008**: The system MUST expose an owner-authenticated registration CRUD: `POST /users/current/webhooks` (create), `GET /users/current/webhooks` (list), `GET /users/current/webhooks/{webhook_id}` (read), `PATCH /users/current/webhooks/{webhook_id}` (update), `DELETE /users/current/webhooks/{webhook_id}` (delete). These require authentication (`401` when unauthenticated) and are `user_id`-scoped; an unknown or cross-user `webhook_id` returns `404` (never `403`, never another user's row).
- **FR-009**: A registration's `secret` MUST be write-only: required on create, updatable on `PATCH`, and NEVER returned by any read (`GET`/list/create response) or written to logs. It MUST be stored **encrypted at rest** (AES-256-GCM via the existing `ENCRYPTION_KEY`, the same recoverable-secret pattern OAuth tokens use), because HMAC verification needs the raw secret; it MUST NOT be stored as plaintext or as a bare hash.
- **FR-010**: Create input MUST require `provider` (a supported enum), a non-empty `repo` (≤255), a non-empty `project` (≤255), and a non-empty `secret`; `(user_id, provider, repo)` MUST be unique. A duplicate registration MUST be rejected (`409`); a missing/invalid field MUST return `400`. On `PATCH`, `project`, `secret`, and `is_enabled` are mutable; `provider` and `repo` are immutable (an attempt to change them returns `400`).
- **FR-011**: The receiver MUST stay within the Workers per-request budget: read the (already `bodyLimit`-bounded) delivery once, do one indexed `(provider, repo)` registration lookup, one secret decrypt + one signature/token check, and one `db.batch()` write — with **no** per-commit DB round-trip and **no** heartbeat scan.
- **FR-012**: The `project` commits land under MUST come from the resolved registration (repo→project), never from the payload or the URL. Webhook-ingested commits MUST be shaped and stored exactly as the ingestion endpoints store them and be immediately retrievable via the existing read endpoints (list + single), honoring their ordering and `author`/`branch` filters.
- **FR-013**: Webhook ingestion MUST NOT alter unrelated aggregates (`summaries`, `hourly_summaries`, `user_projects`) beyond what commit ingestion already does — commits are an independent series.
- **FR-014**: Because the receiver is public and its authenticity comes from the signature (not CSRF/origin), the handler MUST read the raw request bytes once for the HMAC and parse that same buffer (not a second body read), and the route MUST be exempt from the global CSRF guard — mirroring the existing public email-verification POST. (Wiring binding PR2.)
- **FR-015**: Provider payload parsing MUST use only documented public webhook fields, implemented originally; no third-party service source, payload fixtures, or documentation text is copied. Third-party names appear only as the factual `github` / `gitlab` provider identifiers (consistent with the existing `/auth/{provider}` surface); `WakaTime` appears only as `WakaTime-compatible` in documentation, never in code.

### Key Entities

- **`webhook_endpoints`** (NEW table, migration in PR2): one row per registration — `id`, `user_id`, `provider`, `repo`, `project`, `secret_encrypted`, `is_enabled`, `created_at`, `modified_at`; `UNIQUE(user_id, provider, repo)`; indexed on `(provider, repo)` for the delivery lookup and on `(user_id)` for the CRUD list. Mirrors the `ai_model_prices` per-user config conventions and the OAuth `*_encrypted` secret-at-rest pattern.
- **`commits`** (existing, no schema change): the receiver writes the same columns the single/bulk endpoints write, once per mapped commit, in one `db.batch()`, on the existing `(user_id, project, hash)` UNIQUE index.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After a signed GitHub `push` of N commits for a registered repo, all N (≤100) are returned by `GET .../projects/{mapped}/commits` and each by `GET .../commits/{hash}`, under the registration's user and mapped project.
- **SC-002**: A redelivered or overlapping push yields exactly one row per `(user, project, hash)` (idempotent upsert, no duplicates), reflecting the latest mutable-field values.
- **SC-003**: A delivery with a wrong/missing signature writes nothing and returns `401`; an unregistered repo returns `404`; an unsupported provider returns `404`; a disabled registration returns `404` — verified by a follow-up read showing nothing persisted.
- **SC-004**: The `secret` never appears in any create/read/list response or in logs; a stored registration exposes only non-secret fields. Owner A's registrations and webhook-ingested commits are never visible to owner B.
- **SC-005**: A webhook-ingested commit has `total_seconds` absent and `human_readable_total` `"0 secs"` — the receiver never derives a value from heartbeats even when heartbeats surround the commit.
- **SC-006**: A push of up to 100 commits is persisted in a single `db.batch()` (one round-trip), with no per-commit read and no heartbeat query (receiver stays within the per-request budget).
- **SC-007**: Registration CRUD is owner-scoped: create → list/read → patch → delete round-trips, `provider`/`repo` immutable on patch, duplicate `(user, provider, repo)` rejected, unknown/cross-user id → `404`.
