# Data Model: Heartbeat Spec WakaTime-CLI Compatibility

## Entity Changes

### HeartbeatInput (updated)

| Field | Type | Required | Change |
|-------|------|----------|--------|
| entity | string | yes | — |
| type | EntityType enum | yes | **Expanded**: add `url`, `event` |
| time | number (double) | yes | — |
| category | Category enum | no | **Expanded**: add 5 values |
| project | string | no | — |
| project_root_count | integer | no | — |
| branch | string | no | — |
| language | string | no | — |
| dependencies | string \| string[] | no | **Changed**: accept both formats, normalize to array |
| lines | integer | no | — |
| ai_line_changes | integer | no | — |
| human_line_changes | integer | no | — |
| lineno | integer | no | — |
| cursorpos | integer | no | — |
| is_write | boolean | no | — |
| editor | string | no | — |
| operating_system | string | no | — |
| machine | string | no | **New**: machine name |
| user_agent | string | no | **New**: user agent string |

### Heartbeat Response (updated)

All fields from HeartbeatInput plus:

| Field | Type | Required | Change |
|-------|------|----------|--------|
| id | string | yes | — |
| user_id | string | yes | — |
| machine | string | no | — |
| user_agent_id | string | no | — |
| created_at | string (date-time) | yes | — |
| start | number (double) | no | **New**: equals `time` |
| end | number (double) | no | **New**: computed from next heartbeat |
| timezone | string | no | **New**: IANA timezone string |

### HeartbeatBulkItem (new)

| Field | Type | Required |
|-------|------|----------|
| data | `{id: string}` \| null | yes |
| error | string \| null | yes |

Used in bulk response: `responses` is an array of `[HeartbeatBulkItem, integer]` tuples.

### Category Enum (updated)

Existing 16 values plus 5 new:
- `advising`
- `meeting`
- `planning`
- `supporting`
- `translating`

Total: 21 values.

### EntityType Enum (updated)

Existing 3 values plus 2 new:
- `url`
- `event`

Total: 5 values (`file`, `app`, `domain`, `url`, `event`).

## Database Impact

**No schema migration needed.**

- `type` column is TEXT — accepts any string, validation is at application layer.
- `category` column is TEXT — same as above.
- `dependencies` column is TEXT — already stores stringified data. Will now store JSON arrays.
- `machine` column already exists in heartbeats table.
- `user_agent_id` column already exists (references future user_agents table).
- `start`, `end`, `timezone` are computed at query time, not stored.

## Validation Rules

- `type` MUST be one of: `file`, `app`, `domain`, `url`, `event`. Unknown values → 400.
- `category` MUST be one of the 21 defined values. Unknown values → 400.
- `dependencies`: if string, split on commas and trim whitespace. If array, use as-is. Store as JSON string in TEXT column.
- `machine`: body value takes priority over `X-Machine-Name` header.
- `user_agent`: body value takes priority over `User-Agent` header.
