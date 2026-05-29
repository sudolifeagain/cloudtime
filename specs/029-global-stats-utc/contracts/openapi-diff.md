# OpenAPI Diff

`getGlobalStats` loses its `timezone` query parameter and its description is
rewritten to state the endpoint always aggregates in UTC. The existing bad
range behavior is also documented with an explicit `400` response.

## Files touched

1. `schemas/paths/meta/global-stats.yaml`
   - Remove the `timezone` query parameter.
   - Rewrite the operation `description`: unauthenticated, always UTC; explains
     the cache-stability and cross-user-ambiguity rationale (#29).
   - Declare `400` with the shared `BadRequest` response for invalid ranges.

No schema component changes; `GlobalStats` is unchanged (its `range.timezone`
is now always `"UTC"` at runtime, but the field shape is the same).

## Contract

`GET /api/v1/stats/{range}` (unauthenticated):
- Parameters: `range` (path) only. **No `timezone`.**
- `200` → `{ data: GlobalStats }`; `202` → still-calculating; `400` → bad range.

## Generated-types impact

`npm run generate` sets `operations["getGlobalStats"]["parameters"]["query"]`
to `never` (the `timezone` query param is gone) and includes the `400`
BadRequest response for invalid ranges. No success body shapes are affected.

## Backward compatibility

Non-breaking at runtime: clients still sending `?timezone=` are unaffected
(the value is ignored; Hono does not reject unknown query params).

## SDD compliance note

PR1 lands SpecKit + the parameter removal + regenerated types. PR2 lands the
`meta.ts` handler change (ignore timezone, single cache key, `range.timezone =
"UTC"`) and a test. No runtime code in PR1.
