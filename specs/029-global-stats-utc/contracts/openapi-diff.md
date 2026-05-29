# OpenAPI Diff

`getGlobalStats` loses its `timezone` query parameter and its description is
rewritten to state the endpoint always aggregates in UTC. No response-body
change.

## Files touched

1. `schemas/paths/meta/global-stats.yaml`
   - Remove the `timezone` query parameter.
   - Rewrite the operation `description`: unauthenticated, always UTC; explains
     the cache-stability and cross-user-ambiguity rationale (#29).

No schema component changes; `GlobalStats` is unchanged (its `range.timezone`
is now always `"UTC"` at runtime, but the field shape is the same).

## Contract

`GET /api/v1/stats/{range}` (unauthenticated):
- Parameters: `range` (path) only. **No `timezone`.**
- `200` → `{ data: GlobalStats }`; `202` → still-calculating; `400` → bad range.

## Generated-types impact

`npm run generate` sets `operations["getGlobalStats"]["parameters"]["query"]`
to `never` (the `timezone` query param is gone). No other change; no body
shapes affected.

## Backward compatibility

Non-breaking at runtime: clients still sending `?timezone=` are unaffected
(the value is ignored; Hono does not reject unknown query params).

## SDD compliance note

PR1 lands SpecKit + the parameter removal + regenerated types. PR2 lands the
`meta.ts` handler change (ignore timezone, single cache key, `range.timezone =
"UTC"`) and a test. No runtime code in PR1.
