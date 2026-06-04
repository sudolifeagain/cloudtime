# Research & Decisions: Commit ingestion (write path)

**Branch**: `135-commits-ingestion` | **Date**: 2026-06-05

Documented decisions that shape the contract. Each records the choice, the alternatives, and why.

## D-1: Ingestion model — a dedicated authenticated POST

**Decision**: Ingest via `POST /users/current/projects/{project}/commits` with the user's API key. A git `post-commit` hook, a CI step, or a webhook→HTTP adapter is the caller.

**Why**: A commit's identity (`hash`) only comes into existence at `git commit` time, not during the high-frequency heartbeat stream, so attaching commit context to heartbeats is both awkward (the hash is unknown while coding) and wasteful (metadata on every few-second beat). A first-party POST is the smallest correct contract and is provider-agnostic: it does not couple CloudTime to any git host's payload format or signature scheme.

**Alternatives rejected**:
- *Git-host webhook receiver* (`POST /webhooks/git/{provider}`): requires per-user webhook secrets, repo→project mapping, and provider-specific payload parsing/verification — a heavier integration that can sit *in front of* this endpoint later as an adapter.
- *Commit context on heartbeats*: hash unknown at heartbeat time; pollutes the hot path; deriving commits from beats is unreliable.

(Chosen interactively with the maintainer before authoring this spec.)

## D-2: Idempotent upsert, always 201

**Decision**: `INSERT … ON CONFLICT(user_id, project, hash) DO UPDATE SET <mutable fields>`. Re-posting the same hash updates in place. The endpoint always returns `201`.

**Why**: Hooks and webhooks retry; the `commits` table already has a `(user_id, project, hash)` UNIQUE index, so the upsert is natural and duplicate-free. Returning 201 on both insert and update mirrors the existing `createExternalDuration` convention ("re-sending … updates the existing row in place" → 201), keeping the API internally consistent. Distinguishing 200-on-update would add a pre-SELECT for no client benefit.

**Alternatives rejected**: 200-on-update / 201-on-create split — needs an existence probe and complicates the contract; reject-on-duplicate (409) — hostile to safe retries.

## D-3: `total_seconds` is client-supplied; no server-side correlation

**Decision**: Accept an optional `total_seconds` (number `>= 0`) and store it verbatim (nullable). The server does **not** compute coding time by correlating heartbeats around the commit.

**Why**: Keeps ingestion a thin, fast, single-row write. Heartbeat↔commit correlation (which window, which branch, session boundaries) is a meaningfully harder design with its own edge cases and belongs in a separate issue. A client that knows the commit's coding time (e.g. a plugin) can still supply it; one that doesn't simply omits it (read path renders `"0 secs"`).

**Alternatives rejected**: server computes `total_seconds` from heartbeats — heavier, deferred; require `total_seconds` — many callers (a bare git hook) have no coding-time figure.

## D-4: Date handling mirrors the read-path contract

**Decision**: `author_date` / `committer_date` are optional; when present they must parse as valid date-times (else 400) and are stored via the existing `normalizeDateTime`. A missing `author_date` is allowed (stored null).

**Why**: The `Commit` response requires `author_date`; the read path already defaults a missing one to `created_at` (the #128 fix) and normalizes formats. Validating on ingest stops schema-invalid dates from ever entering the table, keeping the read endpoints contract-clean without a second guard.

**Alternatives rejected**: store raw strings unchecked — risks the read path emitting a non-`date-time` value; require `author_date` — over-constrains simple hooks.

## D-5: Minimal validation surface; `project` from the path

**Decision**: Enforce only what protects the read contract: `hash` non-empty, `total_seconds` numeric `>= 0` if present, dates valid if present. `project` comes from the path; a body `project` is ignored. `message`, `ref`, `url` are stored as given.

**Why**: Simplicity. The path already scopes the project (consistent with the read endpoints); echoing/validating a body project invites mismatch bugs. `ref` is the branch the read endpoints filter on, stored verbatim. `url` is advisory (OpenAPI `format: uri`) and not hard-rejected at the route to avoid over-strict failures on valid-but-unusual URLs.

## D-6: Single commit per request; bulk deferred

**Decision**: One commit per POST. Multi-commit (git push event) bulk ingestion is a future addition.

**Why**: Mirrors `createExternalDuration` (single) vs the separate `*-bulk` endpoints; keeps this PR focused. A webhook adapter can fan a push event into N single POSTs, or a future `commits/bulk` can batch them (like `heartbeats/bulk`).

**Alternatives rejected**: accept an array now — broadens the contract and the validation/partial-failure surface beyond this issue's need.
