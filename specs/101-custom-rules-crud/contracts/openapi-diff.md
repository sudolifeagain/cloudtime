# OpenAPI Diff

This PR reconciles the pre-declared custom-rules surface and adds the missing
error responses. The operations themselves (`getCustomRules`,
`updateCustomRules`, `deleteCustomRule`) already existed.

## Files touched

1. `schemas/components/schemas/CustomRule.yaml` — enum + field reconciliation.
2. `schemas/components/schemas/CustomRuleInput.yaml` — enum reconciliation + conditional fields.
3. `schemas/paths/insights/custom-rules.yaml` — add `400` to `PUT`; clarify GET/PUT descriptions.
4. `schemas/paths/insights/custom-rule.yaml` — add `404` to `DELETE`.

No new path items (all three operations were already declared and mounted in
`schemas/openapi.yaml`).

## Schema changes

### `CustomRule` (response)

- `action`: `change | delete` → **`change | hide`** (+ description).
- `operation`: `equals | contains | starts with | ends with` →
  **`equals | contains | starts_with | ends_with`** (+ "no regex" note).
- `destination` / `destination_value`: documented as ignored for `hide`.
- Added `created_at` (date-time) — exposed for the priority tie-break ordering.

### `CustomRuleInput` (PUT body element)

- Same `action` / `operation` reconciliation.
- `destination` / `destination_value` moved **out of `required`** — required for
  `change`, ignored for `hide` (server-enforced; documented in the schema).
- `source_value`: `minLength: 1`.
- `priority`: documented to default to the array index when omitted.
- Removed the `id` input field — PUT is a full replace; ids are server-assigned.

## Response additions

- `PUT /users/current/custom_rules`: add `400` (validation) — set is left
  unchanged on failure.
- `DELETE /users/current/custom_rules/{rule_id}`: add `404` (cross-user /
  unknown id; no existence leak).

## Generated-types impact

`npm run generate` updates `src/types/generated.ts`:

- `components["schemas"]["CustomRule"].action` → `"change" | "hide"`;
  `.operation` → `"equals" | "contains" | "starts_with" | "ends_with"`; adds
  optional `created_at`.
- `components["schemas"]["CustomRuleInput"]` → same enums; `destination` /
  `destination_value` optional; no `id`.
- `operations["updateCustomRules"]` gains a `400` response;
  `operations["deleteCustomRule"]` gains a `404` response.

## Heartbeat remap — no contract change in PR1

The ingestion-time enforcement (rewrite/drop on `POST /heartbeats` and
`/heartbeats.bulk`) is behavioural and lands in PR2. The bulk-response shape
for hidden heartbeats will be verified against the documented
WakaTime-compatible contract in PR2; no heartbeat schema change is anticipated.

## SDD compliance note

PR1 lands SpecKit + schema reconciliation + generated types. PR2 lands the
CRUD handlers, the validation + matcher modules, the ingestion hook, and tests.
No runtime code in PR1.
