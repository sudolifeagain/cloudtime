# Data Model: AI Token Telemetry and Estimated Cost Trends

PR1 does not add database tables, columns, or migrations. The following describes
the contract-level entities and the PR2 storage design they imply.

## Heartbeat AI telemetry (PR2 columns on `heartbeats`)

Added to `HeartbeatInput` in PR1; stored in PR2 as nullable columns on the
existing `heartbeats` table. All numeric fields are non-negative integers.

| Field | Type | Notes |
|---|---|---|
| ai_session | TEXT | Opaque session id, <=255 chars |
| ai_subscription_plan | TEXT | Plan label, <=255 chars; grouping only |
| ai_prompt_length | INTEGER | >= 0 |
| ai_input_tokens | INTEGER | >= 0 |
| ai_output_tokens | INTEGER | >= 0 |
| ai_cached_input_tokens | INTEGER | >= 0 |
| ai_reasoning_output_tokens | INTEGER | >= 0 |
| ai_cache_write_tokens | INTEGER | >= 0 |
| ai_cache_read_tokens | INTEGER | >= 0 |
| ai_provider | TEXT | <=255 chars; else derived from user-agent |
| ai_model | TEXT | <=255 chars; else derived from user-agent |

`ai_line_changes` and `human_line_changes` already exist and are unchanged.

PR2 index for bounded reads: `idx_heartbeats_user_category_time` on
`(user_id, category, time)`.

## `ai_model_prices` (PR2 table)

Owner-scoped, effective-dated rate rows. Rates are per 1,000,000 tokens in
`currency`. Append-only: supersede by inserting a new row or setting
`effective_to`, not by rewriting history.

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | |
| user_id | TEXT NOT NULL | FK -> users(id) ON DELETE CASCADE |
| provider | TEXT NOT NULL | e.g. `openai`, `anthropic`, `local` |
| model | TEXT NOT NULL | e.g. `gpt-4o`, `claude-opus-4` |
| currency | TEXT NOT NULL DEFAULT 'USD' | ISO 4217 |
| input_cost_per_mtok | REAL | >= 0 |
| cached_input_cost_per_mtok | REAL | >= 0 |
| output_cost_per_mtok | REAL | >= 0 |
| reasoning_output_cost_per_mtok | REAL | >= 0 |
| cache_write_cost_per_mtok | REAL | >= 0 |
| cache_read_cost_per_mtok | REAL | >= 0 |
| effective_from | TEXT NOT NULL | RFC 3339, inclusive |
| effective_to | TEXT | RFC 3339, exclusive; null = open-ended |
| source_url | TEXT | provenance; null allowed |
| is_default | INTEGER NOT NULL DEFAULT 0 | 1 for shipped starter rows |
| is_enabled | INTEGER NOT NULL DEFAULT 1 | 0 = ignored in estimation |
| created_at | TEXT NOT NULL DEFAULT (datetime('now')) | |
| updated_at | TEXT NOT NULL DEFAULT (datetime('now')) | |

PR2 indexes:
`idx_ai_model_prices_user ON ai_model_prices(user_id)` and
`idx_ai_model_prices_lookup ON ai_model_prices(user_id, provider, model, effective_from)`.

Validation (enforced server-side, `400` on violation):

- `provider`, `model`, `effective_from` required; at least one rate field
  required.
- `effective_to`, when present, must be strictly after `effective_from`.
- Rates must be `>= 0`; `currency` must be a 3-letter code.
- `provider`, `model`, `effective_from` are immutable on update.
- Default rows (`is_default=1`) are not editable/deletable via owner endpoints.

## AIModelPrice (contract shape)

The API response mirrors the table via `schemas/components/schemas/AIModelPrice.yaml`
(`effective_to`, `source_url` nullable; booleans as `is_default`/`is_enabled`).

## AIUsageSummary (contract shape)

`GET /users/current/ai/usage` returns
`schemas/components/schemas/AIUsageSummary.yaml`:

- `start`, `end`, `timezone`, `currency`, optional `mixed_currency`
- `totals`: `AITokenTotals`
- `daily[]`: `{ date } & AITokenTotals`, ordered by date
- `by_project[]`: `{ project|null } & AITokenTotals`
- `by_agent[]`: `{ agent } & AITokenTotals` (best-effort; `unknown` fallback)
- `by_provider[]`: `{ provider } & AITokenTotals`
- `by_model[]`: `{ provider, model } & AITokenTotals`

`AITokenTotals` carries the six token-class totals, `prompt_length_total`,
`prompt_length_avg` (nullable), `heartbeat_count`, `estimated_cost` (nullable),
and `missing_price_count`.

## Cost calculation semantics

For each contributing heartbeat (category `ai coding` with any priced token
field):

1. Resolve `(provider, model)` from explicit fields, else user-agent, else
   `unknown`.
2. Select the owner's enabled `ai_model_prices` row where
   `provider`/`model` match and `effective_from <= heartbeat.time < effective_to`
   (or `effective_to` is null).
3. If a row matches, add `sum(token_class * rate_class) / 1e6` to the bucket
   cost. If none matches, increment `missing_price_count`.
4. A bucket's `estimated_cost` is the sum of matched contributions, or `null`
   when no contributing heartbeat matched.

Estimated cost is an API-equivalent estimate, never the owner's subscription
bill.
