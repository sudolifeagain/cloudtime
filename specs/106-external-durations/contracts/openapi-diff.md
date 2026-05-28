# OpenAPI Diff

The four `external_durations` operations and the `ExternalDuration` /
`ExternalDurationInput` schemas already existed. This PR adds the missing
error responses and documents the behaviour. No schema field changes.

## Files touched

1. `schemas/paths/external-durations/external-durations.yaml`
   - `getExternalDurations`: add `400`; document day-scoping (timezone),
     invalid timezone handling, `project`/`branches` filters, and the
     parallel-series note.
   - `createExternalDuration`: add `400`; document upsert idempotency on
     `(user_id, external_id)`.
2. `schemas/paths/external-durations/external-durations-bulk.yaml`
   - `createExternalDurationsBulk`: add `400`; document all-or-nothing
     validation, idempotency, and the 100-item cap.
   - `deleteExternalDurationsBulk`: add `400`; document day+id scoping and
     that unknown ids are ignored.

No new operations, no path changes, no schema field changes. `maxItems: 100`
on the bulk body is **kept** (OpenAPI SSoT) over the issue prose's "max 25".

## Contract (shape unchanged)

- `GET /users/current/external_durations?date=...` -> `200 {data: ExternalDuration[]}`, `400`, `401`.
- `POST /users/current/external_durations` → `201 {data: ExternalDuration}`, `400`, `401`.
- `POST /users/current/external_durations.bulk` (≤100) → `201 {data: ExternalDuration[]}`, `400`, `401`.
- `DELETE /users/current/external_durations.bulk` (`{date, ids}`) → `204`, `400`, `401`.

`ExternalDuration` = `ExternalDurationInput` + `id` / `user_id` / `created_at`.

## Generated-types impact

`npm run generate` adds the `400` (BadRequest) responses to all four
operations and the JSDoc descriptions. No request/response **body** type
changes — `ExternalDuration` / `ExternalDurationInput` are untouched.

## SDD compliance note

PR1 lands SpecKit + the response/description additions + regenerated types.
PR2 lands the route handlers and the validation helper, plus tests. No runtime
code in PR1.
