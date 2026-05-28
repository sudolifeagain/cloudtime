# OpenAPI Diff

The `getMachineNames` operation and the `Machine` schema already existed in
`schemas/openapi.yaml`. This PR only clarifies descriptions — there is no
type-shape change.

## Files touched

1. `schemas/paths/tracking/machine-names.yaml` — add a `description` to
   `getMachineNames` (ordering by `last_seen_at` DESC; `ip` is owner-private).
2. `schemas/components/schemas/Machine.yaml` — add field descriptions
   (`value` source, `ip` owner-private/nullable, `last_seen_at` / `created_at`
   meaning).

No new path items, no new operations, no `required`-list change.

## Contract shape (unchanged)

### `GET /users/current/machine_names` → `getMachineNames`

Returns `{"data": Machine[]}` ordered by `last_seen_at` descending.

`Machine` (unchanged required set: `id`, `value`):

- `id`, `value` (hostname) — required
- `ip` — optional, owner-private (the caller's own; omitted when not captured)
- `last_seen_at`, `created_at` — optional date-time

Responses: `200` (list), `401` (unauthenticated).

## Generated-types impact

`npm run generate` adds only JSDoc comments to `operations["getMachineNames"]`
and `components["schemas"]["Machine"]`. The TypeScript types are unchanged
(no field added/removed/required), so no handler is affected by the
regeneration.

## Heartbeat ingestion — no contract change in PR1

The ingestion-time `machine_names` upsert is behavioural and lands in PR2. It
does not alter the heartbeat request/response contract: `machine` remains a
free-text field on `HeartbeatInput` and on the stored row.

## SDD compliance note

PR1 lands SpecKit + the description clarifications + regenerated types
(JSDoc only). PR2 lands the upsert helper, the ingestion hook, the read
route, and tests. No runtime code in PR1.
