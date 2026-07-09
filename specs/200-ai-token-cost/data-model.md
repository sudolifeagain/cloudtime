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
time (FR-025). The cron job derives `provider`/`model`/`agent` once and writes
summed token classes per bucket via `db.batch()`. `provider`/`model` come from
the stored `ai_provider`/`ai_model` fields (else `unknown`); `agent` comes from
the heartbeat's user-agent, whose label lives in the separate `user_agents`
table — `heartbeats.user_agent_id` is only an FK, so the label is not on the
heartbeat row. The cron resolves it with a `LEFT JOIN user_agents` on the
heartbeat fetch (or a batched lookup keyed by the distinct `user_agent_id`s in
the batch, the `getUserSettings` precedent in `aggregate.ts`), falling back to
`unknown`; the heartbeat table itself is still scanned once.

The `day` key is materialized in a fixed **aggregation timezone** — the owner's
profile timezone — with the same `getDateForTimestamp(time, tz)` helper
`summaries` uses for its `date` key (`src/cron/aggregate.ts:125`), but keyed on
the **token heartbeat's own `time`**, not the previous heartbeat's. `summaries`
attributes a *duration interval* `[prev.time, curr.time)` and so keys it by
`prev.time`; AI tokens instead belong to the single heartbeat that reported them
and are summed only from `newHeartbeats`, so each token heartbeat's tokens land
in the local day of its **own** `time`. Keying a 00:01-local token heartbeat by
`prev.time` (e.g. 23:59 the previous day) would misattribute both its `daily[]`
bucket and its price window (pricing it against the previous day's effective
row). Day boundaries are therefore stable once written; the request `timezone`
param selects and labels the range but never re-buckets already-aggregated days
(FR-008).

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | `AUTOINCREMENT` surrogate key (mirrors `summaries`) |
| user_id | TEXT NOT NULL | FK -> users(id) |
| day | TEXT NOT NULL | local-day key (`YYYY-MM-DD`) in the fixed aggregation timezone (owner profile tz) |
| provider | TEXT NOT NULL | resolved at aggregation; `unknown` fallback |
| model | TEXT NOT NULL | resolved at aggregation; `unknown` fallback |
| agent | TEXT NOT NULL | resolved from user-agent; `unknown` fallback |
| project | TEXT NOT NULL DEFAULT '' | `''` sentinel for heartbeats with no project; mapped back to `null` in `by_project[]` |
| input_tokens | INTEGER NOT NULL DEFAULT 0 | sum of `ai_input_tokens` |
| output_tokens | INTEGER NOT NULL DEFAULT 0 | sum of `ai_output_tokens` |
| cached_input_tokens | INTEGER NOT NULL DEFAULT 0 | |
| reasoning_output_tokens | INTEGER NOT NULL DEFAULT 0 | |
| cache_write_tokens | INTEGER NOT NULL DEFAULT 0 | |
| cache_read_tokens | INTEGER NOT NULL DEFAULT 0 | |
| prompt_length_total | INTEGER NOT NULL DEFAULT 0 | sum of reported `ai_prompt_length` across the bucket's *contributing* heartbeats |
| prompt_length_count | INTEGER NOT NULL DEFAULT 0 | count of *contributing* heartbeats that carried `ai_prompt_length` (for avg) |
| heartbeat_count | INTEGER NOT NULL DEFAULT 0 | count of *contributing* heartbeats (FR-026): `ai coding` rows with ≥1 priced token field |
| updated_at | TEXT NOT NULL DEFAULT (datetime('now')) | |

Uniqueness follows the working `summaries` pattern, not a nullable composite
PRIMARY KEY: a surrogate `id INTEGER PRIMARY KEY AUTOINCREMENT` plus
`CREATE UNIQUE INDEX idx_ai_daily_usage_unique ON ai_daily_usage(user_id, day, provider, model, agent, project)`
as the UPSERT conflict target, and `idx_ai_daily_usage_user_day ON ai_daily_usage(user_id, day)`
for range reads. Every rollup key column is `NOT NULL` (nullable source
dimensions — currently only `project` — are coalesced to a `''` sentinel by the
cron *before* the `ON CONFLICT DO UPDATE`, mirroring `prev.project ?? ""` in
`src/cron/aggregate.ts:126`), so no `NULL` ever reaches the conflict target. This
matters because SQLite does **not** implicitly make `PRIMARY KEY` columns of a
rowid table `NOT NULL`, and `NULL`s compare distinct in a unique index; a
nullable-`project` composite key would let `DO UPDATE` silently miss on
null-project buckets, INSERTing a fresh duplicate every incremental run and
double-counting token sums. Aggregation is incremental (only heartbeats newer
than the watermark) and UPSERTs bucket sums, so a wide `/ai/usage` call reads a
bounded number of rollup rows, not raw heartbeats.

**Rollup build predicate & counts (FR-026).** The cron inserts/updates a bucket
only for *contributing* heartbeats — `category = 'ai coding'` with at least one
priced token field present (`ai_input_tokens`, `ai_output_tokens`,
`ai_cached_input_tokens`, `ai_reasoning_output_tokens`, `ai_cache_write_tokens`,
or `ai_cache_read_tokens`, decided by presence not value, so `ai_input_tokens: 0`
still qualifies). A heartbeat carrying only `ai_prompt_length` and no priced
token field is **not** contributing and **creates no rollup bucket**, so it is
excluded from every rollup column. Concretely the build filter is
`category = 'ai coding' AND (ai_input_tokens IS NOT NULL OR ai_output_tokens IS
NOT NULL OR ai_cached_input_tokens IS NOT NULL OR ai_reasoning_output_tokens IS
NOT NULL OR ai_cache_write_tokens IS NOT NULL OR ai_cache_read_tokens IS NOT
NULL)`. `heartbeat_count` therefore counts only contributing heartbeats, and
`prompt_length_total`/`prompt_length_count` sum/count `ai_prompt_length` across
those contributing heartbeats that also reported it (so `prompt_length_avg =
prompt_length_total / prompt_length_count`, `null` when the count is 0). This
keeps the rollup columns byte-consistent with `AITokenTotals` — which excludes
prompt-length-only heartbeats from every field — and avoids writing all-zero-token
buckets that would bloat the rollup and inflate the `missing_price_count`
denominator.

**PR2 cron note (double-count hazard):** `aggregateHeartbeats` prepends
`lookbackHeartbeats` (`time <= watermark`) for session-gap continuity
(`src/cron/aggregate.ts:212`); the AI token SUMs MUST include only
`newHeartbeats` (`time > watermark`), or each lookback heartbeat's tokens are
re-added on every run. The fetch SELECT (`aggregate.ts:180-201`) must also be
extended to read the new `ai_*` columns and the `user_agent_id` (joined or
looked up against `user_agents` for the `agent` dimension, per above). The
`ai_daily_usage` UPSERTs MUST be enqueued in the **same** `db.batch()` as the
`last_aggregated_at` watermark advance (exactly as the existing `summaries`
aggregation does), so the watermark can never advance without the rollup rows
persisting (which would drop those heartbeats) and the rollup can never persist
without the watermark advancing (which would reprocess and double-count).

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
   instant, in the same fixed aggregation timezone the `day` key was materialized
   in — the owner's profile timezone — converted to UTC, so the price window is
   evaluated against the same boundaries the bucket was built on and stays a
   fixed, reproducible instant). When more than one enabled row matches, apply the
   deterministic precedence (FR-021): **owner row over default row, then latest
   `effective_from`**. Overlapping enabled windows within one default class are
   forbidden at write time, so this yields exactly one row.
2. A matched row **fully prices** the bucket only when its currency equals the
   summary currency **and it defines a non-null rate for every token class the
   bucket has nonzero usage in**; then add
   `sum(token_class_total * rate_class) / 1e6` to the bucket cost. If no row
   matches `(provider, model)` at the resolution instant, the matched row's
   currency differs from the summary currency, **or the matched row leaves a
   nonzero token class unpriced (a null rate for a class the bucket used)**, the
   bucket is treated as unpriced: count its contributing heartbeats in
   `missing_price_count` and add nothing to the cost. Because a price row may
   legitimately define only some rate classes (validation requires only one), a
   row is a *full match* for a bucket only when it covers all of that bucket's
   nonzero classes. This preserves the "never a silent zero" guarantee
   (FR-010 / SC-003): a partial-rate row can never value a used-but-unpriced
   class at 0 inside a non-null `estimated_cost`; the whole bucket surfaces in
   `missing_price_count` instead. `estimated_cost` thus reflects only
   fully-priced buckets — a clean partition, no bucket is both partly summed and
   flagged.

**Summary currency selection (FR-022):** the summary reports one `currency`,
chosen as the currency of the enabled price rows matching the most contributing
heartbeats in the range (ties → smallest ISO code; `USD` when nothing matched).
Costs are never summed across currencies; buckets priced in another currency set
`mixed_currency=true` and fall into `missing_price_count` as above.

A bucket's / summary's `estimated_cost` is the sum of matched same-currency
contributions, or `null` when no contributing heartbeat matched an enabled price
row in the summary currency. Per-heartbeat token fields are bounded to `<= 1e9`
(FR-023) and bucket sums are stored as D1 `INTEGER` (64-bit), so storage never
overflows. The `<= 1e9` cap is per-field-per-heartbeat, not a per-aggregate
bound: a single bucket summing more than ~9e6 max-value heartbeats can still
exceed JavaScript's `2^53` safe-integer range when serialized to JSON, so PR2
MUST keep such sums exact at the JSON boundary (or document the observed
ceiling). Cost accumulates as a double.

Estimated cost is an API-equivalent estimate, never the owner's subscription
bill.
