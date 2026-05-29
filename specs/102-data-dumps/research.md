# Research: Data Dumps (Export)

## Decision 1: R2-gated, fail-closed (503 when unbound)

**Decision**: The feature requires a bound `R2_BUCKET`. When it is not bound, `getDataDumps` and `createDataDump` return 503 ("Data export not configured"). Operators opt in by binding the bucket in `wrangler.toml`.

**Rationale**:
- Exports of any size belong in object storage, not D1 (row-size limits) or inline response bodies (defeats async). R2 is the Cloudflare-native choice.
- Gating on the binding mirrors the email-delivery pattern (`EMAIL_PROVIDER` → 503), so the feature can merge and run on instances that have not provisioned R2 without erroring confusingly — it simply reports "not configured".

**Alternative considered**: inline body on first GET (no R2). Rejected — defeats async semantics and breaks for large `full` dumps. D1 BLOB: rejected — row-size limited.

---

## Decision 2: Async via the existing hourly cron sweep (not Queues)

**Decision**: `POST` records a `pending` row; the existing hourly cron builds pending dumps and purges expired ones. No Cloudflare Queues binding is introduced.

**Rationale**:
- The project already runs an hourly cron (aggregation + session cleanup + heartbeat purge). Adding a dump sweep there reuses proven wiring and avoids a new Queues binding/consumer to operate.
- Export latency of up to ~1 hour is acceptable for a migration/backup feature; it is not interactive.

**Alternative considered**: Cloudflare Queues for near-immediate processing. Rejected for the first cut — more infrastructure for a non-interactive feature; can be added later behind the same `data_dumps` contract.

---

## Decision 3: `type` = `daily | full`; `status` + `expired`

**Decision**: Reconcile the declared `type` enum `daily | heartbeats` → **`daily | full`**, and add **`expired`** to the `status` enum (`pending | processing | completed | failed | expired`).

**Rationale**:
- The issue's scope states `type = daily | full`, and its "output format" lists a multi-file bundle (user / summaries / daily / heartbeats). A `full` export serves the migration/portability use cases far better than a heartbeats-only dump; `heartbeats` is a *component* of `full`, not a useful standalone primary type.
- `expired` is needed to represent dumps whose 7-day window has passed and whose R2 object was purged — distinct from `completed`.

**Flagged for review**: this changes the declared `heartbeats` enum value to `full`. It is a deliberate spec-first reconciliation toward the issue's intent; called out in the PR description for sign-off.

**Alternative considered**: keep `daily | heartbeats` (strict SSoT). Rejected — it contradicts the issue's own scope and output description; the SSoT is being corrected here, which is what a spec-first PR is for.

---

## Decision 4: JSON bundle; R2 key per dump

**Decision**: A dump is a single JSON object stored at `dumps/{user_id}/{dump_id}.json`. `daily` = `{ user, summaries (per-day) }`; `full` = `{ user, summaries, daily, heartbeats }`. No zip/compression in the first cut.

**Rationale**:
- A single JSON object is trivial to produce in a Worker (no zip library) and to consume downstream. The per-user/per-dump key namespaces objects and makes purge a single delete.
- Compression can be layered later (e.g. gzip on `put`) without changing the contract.

**Alternative considered**: a zip of separate files (`user.json`, `heartbeats.json`, …). Rejected for the first cut — needs a zip lib in the Worker; the one-object JSON is simpler and equivalent for tooling.

---

## Decision 5: Worker-mediated download (no S3 presign creds)

**Decision**: `download_url` points at a worker-mediated route that validates ownership + a short-lived token and streams the R2 object, rather than an S3 presigned URL. Expired/unknown → 404.

**Rationale**:
- R2 S3 presigned URLs require provisioning S3 API credentials and signing — extra setup and secrets. A worker route that reads the object via the existing `R2_BUCKET` binding and checks auth/token is simpler and needs no new credentials.
- Keeps the "short-lived, owner-only" guarantee (token + expiry) without public durable links.

**Alternative considered**: R2 S3 presigned URLs. Viable when an operator has S3 creds configured; left as an option for PR2 but not the default. The exact download route is finalised in PR2 (it is not a new OpenAPI operation in PR1).

---

## Decision 6: Dedupe pending requests

**Decision**: A `POST` for a `type` that already has a `pending` or `processing` dump returns that existing dump instead of creating another.

**Rationale**:
- Bounds work and storage: a user (or a retrying client) cannot queue dozens of identical full exports. Returning the in-flight dump is the least-surprising idempotent behaviour.

**Alternative considered**: 409 Conflict on a duplicate. Rejected — returning the existing dump is friendlier and lets clients poll the same id.
