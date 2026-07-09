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

`is_default` scoping: rows are always `user_id`-scoped (`NOT NULL`). When PR2
ships starter defaults it seeds one owner-scoped copy per user
(`is_default=1`, read-only via the owner endpoints), so every lookup stays a
plain `WHERE user_id = ?` — there is no global/nullable-`user_id` row and no
UNION-with-global special case (FR-024).

Validation (enforced server-side, `400` on violation):

- `provider`, `model`, `effective_from` required; at least one rate field
  required.
- `effective_to`, when present, must be strictly after `effective_from`.
- Rates must be `>= 0` and `<= 1e6`; `currency` must match `^[A-Z]{3}$`
  (upper-case ISO 4217).
- `source_url`, when present, must be an `http`/`https` URL (`<=2048` chars).
- `provider`, `model`, `effective_from` are immutable on update (a PATCH that
  sends any of them returns `400`; enforced server-side and covered by tests
  since JSON Schema cannot express it on an open update body).
- Two **enabled** rows of the same default class (both owner, or both default)
  for one `(user_id, provider, model)` must not have overlapping
  `[effective_from, effective_to)` windows, so at most one enabled row per class
  matches any instant (FR-021).
- Default rows (`is_default=1`) are not editable/deletable via owner endpoints
  (return `404`).

## `ai_daily_usage` (PR2 rollup table)

To stay within the request CPU budget and match the existing cron-rollup
architecture (`summaries` / `hourly_summaries`, built incrementally by
`cron/aggregate.ts` from a `last_aggregated_at` watermark), `/ai/usage` reads a
pre-aggregated daily rollup rather than scanning raw `heartbeats` at request
time (FR-025). The cron job derives `provider`/`model`/`agent` once (from the
stored `ai_provider`/`ai_model` fields, else user-agent metadata, else
`unknown`) and writes summed token classes per bucket via `db.batch()`.

| Column | Type | Notes |
|---|---|---|
| user_id | TEXT NOT NULL | FK -> users(id) |
| day | TEXT NOT NULL | local-day key (`YYYY-MM-DD`) in the aggregation timezone |
| provider | TEXT NOT NULL | resolved at aggregation; `unknown` fallback |
| model | TEXT NOT NULL | resolved at aggregation; `unknown` fallback |
| agent | TEXT NOT NULL | resolved from user-agent; `unknown` fallback |
| project | TEXT | null for heartbeats with no project |
| input_tokens | INTEGER NOT NULL DEFAULT 0 | sum of `ai_input_tokens` |
| output_tokens | INTEGER NOT NULL DEFAULT 0 | sum of `ai_output_tokens` |
| cached_input_tokens | INTEGER NOT NULL DEFAULT 0 | |
| reasoning_output_tokens | INTEGER NOT NULL DEFAULT 0 | |
| cache_write_tokens | INTEGER NOT NULL DEFAULT 0 | |
| cache_read_tokens | INTEGER NOT NULL DEFAULT 0 | |
| prompt_length_total | INTEGER NOT NULL DEFAULT 0 | sum of reported `ai_prompt_length` |
| prompt_length_count | INTEGER NOT NULL DEFAULT 0 | count with `ai_prompt_length` (for avg) |
| heartbeat_count | INTEGER NOT NULL DEFAULT 0 | contributing heartbeats (FR-026) |
| updated_at | TEXT NOT NULL DEFAULT (datetime('now')) | |

PK `(user_id, day, provider, model, agent, project)`; index
`idx_ai_daily_usage_user_day ON ai_daily_usage(user_id, day)` for range reads.
Aggregation is incremental (only heartbeats newer than the watermark) and
UPSERTs bucket sums, so a wide `/ai/usage` call reads a bounded number of
rollup rows, not raw heartbeats.

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

Cost is computed **aggregate-then-price** over the `ai_daily_usage` rollup, not
per raw heartbeat at read time. A *contributing heartbeat* is one with category
`ai coding` carrying at least one priced token field (FR-026); heartbeats with
only `ai_prompt_length` do not contribute.

For each rollup bucket `(day, provider, model, agent, project)`:

1. Select the effective enabled `ai_model_prices` row for the bucket's
   `(user_id, provider, model)` whose `[effective_from, effective_to)` window
   contains the bucket's day (resolved at the bucket day's local start-of-day
   instant, in the summary timezone, converted to UTC — a fixed, reproducible
   instant). When more than one enabled row matches, apply the
   deterministic precedence (FR-021): **owner row over default row, then latest
   `effective_from`**. Overlapping enabled windows within one default class are
   forbidden at write time, so this yields exactly one row.
2. If a row matches **and its currency equals the summary currency**, add
   `sum(token_class_total * rate_class) / 1e6` to the bucket cost. If no row
   matches, or the matched row's currency differs from the summary currency,
   count the bucket's contributing heartbeats in `missing_price_count` and add
   nothing to the cost.

**Summary currency selection (FR-022):** the summary reports one `currency`,
chosen as the currency of the enabled price rows matching the most contributing
heartbeats in the range (ties → smallest ISO code; `USD` when nothing matched).
Costs are never summed across currencies; buckets priced in another currency set
`mixed_currency=true` and fall into `missing_price_count` as above.

A bucket's / summary's `estimated_cost` is the sum of matched same-currency
contributions, or `null` when no contributing heartbeat matched an enabled price
row in the summary currency. Token sums accumulate as bounded integers
(per-field `<= 1e9`, FR-023) and cost accumulates as a double, keeping every
aggregate within safe numeric range.

Estimated cost is an API-equivalent estimate, never the owner's subscription
bill.
