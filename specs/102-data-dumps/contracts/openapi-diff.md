# OpenAPI Diff

The `getDataDumps` / `createDataDump` operations and the `DataDump` schema
already existed. This PR reconciles the enums and adds the missing error
responses (`400`, `503`). No new operations.

## Files touched

1. `schemas/components/responses/ServiceUnavailable.yaml` — **new** `503`
   response (capability not configured) with required `error`.
2. `schemas/components/schemas/DataDump.yaml` — `type` `daily|heartbeats` →
   **`daily|full`**; `status` adds **`expired`**; make `created_at`
   required; field descriptions (`download_url`, `created_at`, `expires_at`).
3. `schemas/paths/users/data-dumps.yaml`
   - `getDataDumps`: add `503`; document R2 gating + status/`download_url`.
   - `createDataDump`: request `type` enum → `daily|full`; add `400` + `503`;
     document async cron lifecycle, 7-day expiry, and `email_when_finished`
     (multi-user only).

No path changes; no new operations.

## Reconciliations (flagged for review)

- **`type`: `heartbeats` → `full`.** The issue's scope says `type=daily|full`
  and describes a multi-file bundle; `full` (user + summaries + daily +
  heartbeats) serves migration/portability, where `heartbeats`-only did not.
  This corrects the declared enum toward the issue's intent — a spec-first
  change called out for sign-off.
- **`status`: add `expired`.** Needed to represent dumps past `expires_at`
  whose R2 object has been purged (distinct from `completed`).

## Contract

- `GET /users/current/data_dumps` → `200 {data: DataDump[]}`, `401`, `503`.
- `POST /users/current/data_dumps` (`{type: daily|full, email_when_finished?}`)
  → `201 {data: DataDump}`, `400`, `401`, `503`.

`DataDump`: `type ∈ {daily, full}`, `status ∈ {pending, processing,
completed, failed, expired}`, optional `download_url` (when completed),
required `created_at`, optional `expires_at`.

## Generated-types impact

`npm run generate` updates `components["schemas"]["DataDump"]` (`type`,
`status` enums, required `created_at`), adds the `503` response to both
operations and `400` to `createDataDump`, and the `createDataDump` request
`type` enum. `ServiceUnavailable.error` is required.

## SDD compliance note

PR1 lands SpecKit + the enum/response reconciliation + regenerated types.
PR2 lands the `R2_BUCKET` binding, the route handlers, the cron build/purge,
the export bundler, and tests. No runtime code in PR1.
