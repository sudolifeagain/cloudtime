# OpenAPI Diff: AI Token Telemetry and Estimated Cost Trends

## Changed Schema

### `HeartbeatInput`

Adds optional AI telemetry properties (all additive, backward compatible). All
token/length integers are bounded `minimum: 0`, `maximum: 1000000000` to keep
cost accumulation within safe numeric range and reject garbage (FR-023):

- `ai_session`: string, `maxLength: 255`
- `ai_subscription_plan`: string, `maxLength: 255`
- `ai_prompt_length`: integer, `0..1e9`
- `ai_input_tokens`: integer, `0..1e9`
- `ai_output_tokens`: integer, `0..1e9`
- `ai_cached_input_tokens`: integer, `0..1e9`
- `ai_reasoning_output_tokens`: integer, `0..1e9`
- `ai_cache_write_tokens`: integer, `0..1e9`
- `ai_cache_read_tokens`: integer, `0..1e9`
- `ai_provider`: string, `maxLength: 255`
- `ai_model`: string, `maxLength: 255`

Because `Heartbeat` is `allOf: [HeartbeatInput, ...]`, and
`HeartbeatBulkItem` wraps created ids, the stored AI fields flow through to
`Heartbeat` responses and bulk ingestion without further schema changes.

## Added Schemas

- `AITokenTotals`: token-class totals (`input`, `cached_input`, `output`,
  `reasoning_output`, `cache_write`, `cache_read`), `prompt_length_total`,
  nullable `prompt_length_avg`, `heartbeat_count`, nullable `estimated_cost`,
  and `missing_price_count`.
- `AIUsageSummary`: `start`, `end`, `timezone`, `currency`, optional
  `mixed_currency`, `totals`, and `daily` / `by_project` / `by_agent` /
  `by_provider` / `by_model` arrays composed with `AITokenTotals` via `allOf`.
- `AIModelPrice`: effective-dated price row with per-1M-token rate classes
  (`0..1e6`), `currency` (`^[A-Z]{3}$`), `effective_from`, nullable
  `effective_to`, nullable `source_url` (`http(s)` `format: uri`), `is_default`,
  `is_enabled`, and timestamps.
- `AIModelPriceInput`: create body (`provider`, `model`, `effective_from`
  required; at least one rate required server-side).
- `AIModelPriceUpdate`: partial update body; `provider`, `model`, and
  `effective_from` are omitted because they are immutable.

## Added Paths

### `GET /users/current/ai/usage`

Owner-only. Query: `start`, `end`, `days` (default 30, max 366), `timezone`,
`project`. Range resolution is deterministic (`start`+`end` precedence over
`days`; one-sided range, `start>end`, `>366d`, or bad `timezone` → `400`).
Responses: `200` (`{data: AIUsageSummary}`), `400`, `401`.

### `GET /users/current/ai/prices`

Owner-only list. Query: `provider`, `model`, `active_on`, `include_disabled`.
Responses: `200` (`{data: AIModelPrice[]}`), `400` (malformed `active_on` /
`include_disabled`), `401`.

### `POST /users/current/ai/prices`

Owner-only create. Body `AIModelPriceInput`. Responses: `201`
(`{data: AIModelPrice}`), `400`, `401`.

### `GET /users/current/ai/prices/{price_id}`

Owner-only read. Responses: `200` (`{data: AIModelPrice}`), `401`, `404`.

### `PATCH /users/current/ai/prices/{price_id}`

Owner-only update. Body `AIModelPriceUpdate`. Responses: `200`
(`{data: AIModelPrice}`), `400`, `401`, `404`.

### `DELETE /users/current/ai/prices/{price_id}`

Owner-only delete of an owner-created row. Responses: `204`, `401`, `404`
(default rows and cross-user ids return `404`).

## Tag

Adds the `ai` tag: "Owner-only AI coding token usage, pricing, and estimated cost
analytics".

## Generated Types

After `npm run generate`, TypeScript clients receive:

- extended `HeartbeatInput` (and therefore `Heartbeat`) with the AI fields
- new operations `getAiUsage`, `getAiPrices`, `createAiPrice`, `getAiPrice`,
  `updateAiPrice`, `deleteAiPrice`
- new schemas `AITokenTotals`, `AIUsageSummary`, `AIModelPrice`,
  `AIModelPriceInput`, `AIModelPriceUpdate`

## Compatibility

All changes are additive. No existing path, schema property, or response is
removed or narrowed. Existing heartbeat ingestion and reads are unchanged when AI
fields are absent.
