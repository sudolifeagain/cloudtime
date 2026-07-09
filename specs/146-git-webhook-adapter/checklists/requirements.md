# Requirements Checklist: Git-host webhook adapter

**Branch**: `146-git-webhook-adapter` | **Spec**: [spec.md](../spec.md)

Quality gate for the spec before implementation. Each item is verifiable against `spec.md`.

## Completeness

- [x] Every functional requirement (FR-001…FR-015) maps to at least one acceptance scenario or success criterion.
- [x] Public receiver shape fixed and justified (`/webhooks/git/{provider}`, `security: []`, repo from payload, no URL secret) — research D-1.
- [x] Provider set fixed (`github` + `gitlab`) behind a per-provider adapter; more providers deferred — research D-2.
- [x] Verification fixed: GitHub HMAC-SHA256 over the raw body, GitLab token header, constant-time compare — FR-003, research D-3.
- [x] Secret handling fixed: write-only, AES-256-GCM encrypted at rest (not hash, not plaintext), never in URL/logs — FR-009, research D-4.
- [x] Payload → `CommitInput` mapping fixed (documented fields, clamp, best-effort skip) — FR-004/FR-006, research D-5.
- [x] Reuse of the bulk write path with **no** heartbeat correlation, cap 100, single `db.batch()` — FR-005/FR-011, research D-6.
- [x] Response contract fixed (`202` ack with counts; `ping`/non-push zero; `400`/`401`/`404`) — FR-007, research D-7.
- [x] Owner CRUD fixed (create/list/read/patch/delete; immutable provider/repo; duplicate 409; 404-not-403) — FR-008/FR-010, research D-8.
- [x] Delivery resolution + multi-user boundary stated — FR-010, research D-9.
- [x] Public-POST wiring recorded (raw body once, CSRF exemption) — FR-014, research D-10.

## Consistency

- [x] `security: []` receiver overrides the global auth requirement (same as public cards #160) — FR-001, research D-1.
- [x] CRUD inherits global auth and is `user_id`-scoped with 404-not-403 (mirrors `/ai/prices`) — FR-008, research D-8.
- [x] Webhook fan-out reuses the single/bulk commit upsert unchanged; `total_seconds` never derived — FR-005/FR-012, data-model.
- [x] Secret stored via the OAuth `*_encrypted` precedent (`ENCRYPTION_KEY`), never hashed for this use — FR-009, research D-4.
- [x] Read endpoints (#107) unchanged; webhook-ingested rows flow through their ordering/filters — FR-012.
- [x] Single/bulk commit endpoints (#135/#145/#147) unchanged; the receiver reuses their upsert — spec Background, tasks Out of scope.

## Testability

- [x] Each user story has an Independent Test.
- [x] Success criteria are measurable (SC-001…SC-007), including the single-round-trip `db.batch()` claim (SC-006) and the write-only-secret claim (SC-004).
- [x] Quickstart scenarios A–K cover register, signed GitHub/GitLab push, read-back "0 secs", verification/unmapped/unsupported/ping/disabled, idempotent redelivery, best-effort skip, CRUD patch/immutability/duplicate/delete/auth, and secret write-only + isolation.

## Compliance

- [x] No schema change in PR1 (the `webhook_endpoints` migration is a PR2 task); D1 bulk write via a single `db.batch()`; one indexed lookup, no per-commit round-trip, no heartbeat scan (Cloudflare-Native, Simplicity) — FR-011, research D-6.
- [x] Generated-types impact assessed (additive: six operations, three path members, two schemas, one tag) in contracts/openapi-diff.md.
- [x] Original receiver + original parsing of documented public payload fields; no third-party source/fixtures; `github`/`gitlab` are integration identifiers (as in `/auth/{provider}`); `WakaTime` only `WakaTime-compatible` in docs (Legal/Trademark) — FR-015, research D-5.
- [x] No secret in any public URL or read response; secret encrypted at rest and write-only (implementation-boundaries) — FR-009, research D-1/D-4.
