# Quickstart: AI Token Telemetry and Estimated Cost Trends

This quickstart describes the expected behavior after PR2 implementation. PR1
only defines the contract.

## Send AI heartbeats from a compatible client

A WakaTime-compatible client configured with a CloudTime `api_url` sends AI
activity through the existing bulk heartbeat endpoint. AI token fields are
optional and additive:

```json
{
  "entity": "src/app.ts",
  "type": "file",
  "time": 1789900000.0,
  "category": "ai coding",
  "project": "cloudtime",
  "language": "TypeScript",
  "ai_session": "sess_abc123",
  "ai_subscription_plan": "pro",
  "ai_prompt_length": 812,
  "ai_input_tokens": 1200,
  "ai_output_tokens": 340,
  "ai_cached_input_tokens": 900,
  "ai_provider": "anthropic",
  "ai_model": "claude-opus-4"
}
```

Heartbeats that omit AI fields keep working unchanged.

## Read stored telemetry

```powershell
# Owner-authenticated
GET /api/v1/users/current/heartbeats?date=2026-06-20
# -> data[].ai_input_tokens, ai_output_tokens, ai_session, ... present when stored
```

## Configure pricing (owner-only)

```powershell
POST /api/v1/users/current/ai/prices
{
  "provider": "anthropic",
  "model": "claude-opus-4",
  "currency": "USD",
  "input_cost_per_mtok": 15,
  "cached_input_cost_per_mtok": 1.5,
  "output_cost_per_mtok": 75,
  "effective_from": "2026-01-01T00:00:00Z",
  "source_url": "https://platform.claude.com/docs/en/about-claude/pricing"
}

GET   /api/v1/users/current/ai/prices?provider=anthropic
PATCH /api/v1/users/current/ai/prices/{price_id}   # e.g. { "is_enabled": false }
DELETE /api/v1/users/current/ai/prices/{price_id}  # owner rows only; defaults return 404
```

## View usage and estimated cost (owner-only)

```powershell
GET /api/v1/users/current/ai/usage?days=30&timezone=Asia/Tokyo
GET /api/v1/users/current/ai/usage?start=2026-06-01&end=2026-06-30
```

Response includes `daily[]` token trends and `by_project` / `by_agent` /
`by_provider` / `by_model` breakdowns, each with token totals and
`estimated_cost`. When no price row matches, `estimated_cost` is `null` and
`missing_price_count` is non-zero.

## Expected Responses

- `200 application/json`: authenticated owner, valid request.
- `400 application/json`: invalid range (>366 days), malformed token field,
  invalid price body, or an immutable price field on `PATCH`.
- `401 application/json`: no authenticated owner.
- `404 application/json`: unknown or cross-user `price_id`, or a default row on
  edit/delete.

## Validation Commands

```powershell
npm run lint:api
npm run generate
npm run typecheck
npm test -- tests/integration/ai-heartbeats.test.ts tests/integration/ai-usage.test.ts tests/aggregation/ai-pricing.test.ts
```
