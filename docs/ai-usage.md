# AI Token Usage and Estimated Cost

CloudTime can record AI coding token telemetry alongside normal heartbeats and
turn it into an owner-only usage summary with an **API-equivalent estimated
cost**. This document describes how compatible clients report the data, how the
rollup and cost estimate are built, and where to manage it in the dashboard.

> **Estimate, not a bill.** Every `estimated_cost` is derived from the pricing
> table you configure and reflects *API-equivalent* rates per 1,000,000 tokens.
> It is not your actual subscription or provider invoice. Buckets that no enabled
> price row can fully price surface a `missing_price_count` and a `null` cost —
> never a silent zero.

## Ingesting AI telemetry

AI telemetry travels on the existing heartbeat endpoints
(`POST /api/v1/users/current/heartbeats` and the bulk `.bulk` variant). A
WakaTime-compatible editor client that reports AI activity sends `ai coding` as
the heartbeat `category` and adds the optional AI fields it knows about. All AI
fields are optional; omitting them keeps a heartbeat fully backward compatible.

| Field | Meaning |
| --- | --- |
| `ai_provider` | Provider identifier (e.g. `openai`, `anthropic`). Derived best-effort from the user agent when absent. |
| `ai_model` | Model identifier (e.g. `gpt-4o`, `claude-opus-4`). Derived best-effort from the user agent when absent. |
| `ai_input_tokens` | Fresh input (prompt) tokens. |
| `ai_cached_input_tokens` | Input tokens served from a provider prompt cache. |
| `ai_output_tokens` | Output (completion) tokens. |
| `ai_reasoning_output_tokens` | Reasoning/thinking output tokens. |
| `ai_cache_write_tokens` | Tokens written to a provider prompt cache. |
| `ai_cache_read_tokens` | Tokens read from a provider prompt cache. |
| `ai_prompt_length` | Client-reported prompt length. The unit (characters vs tokens) is client-defined and **never** used for cost — it is trend context only. |

Token and length values are validated as non-negative integers within a bounded
range; malformed values return `400`. A missing field means "not reported"; an
explicit `0` means "reported as zero" and is preserved.

A heartbeat is **contributing** — counted in token totals and eligible for cost
estimation — when it is `category = 'ai coding'` and carries at least one priced
token field (any of the six token classes above). Presence, not value, decides
this: a heartbeat with `ai_input_tokens: 0` contributes, while a heartbeat that
carries only `ai_prompt_length` does not.

## Usage summary

`GET /api/v1/users/current/ai/usage` returns an owner-only `AIUsageSummary` over
a bounded date range: token totals, a daily trend, and breakdowns by project, AI
agent/tool, provider, and model. Each carries token totals and an
`estimated_cost` in a single summary `currency`.

Query parameters:

- `start` + `end` (`YYYY-MM-DD`, inclusive) — supply both or neither; supplying
  one alone is a `400`. `start > end` and spans over 366 days are rejected.
- `days` — trailing window size (default `30`, max `366`), ignored when
  `start`/`end` are given.
- `timezone` — IANA name used only to resolve the range and "today" and to label
  the response. It never re-buckets stored days (see below).
- `project` — restrict the summary to one project.

The endpoint reads the cron-maintained `ai_daily_usage` rollup and never scans
raw heartbeats at request time, keeping it within the Workers CPU budget (see
[cloudflare-constraints.md](cloudflare-constraints.md)).

### Aggregate-then-price

Cost is computed **once per daily rollup bucket**, not per heartbeat. For each
bucket, CloudTime selects the effective enabled price row whose
`[effective_from, effective_to)` window contains the bucket day's start-of-day
instant in the **fixed aggregation timezone** (the owner's profile timezone the
rollup days were materialized in). Because prices are effective-dated and days
are never re-bucketed to a request timezone, historical estimates stay
reproducible.

If a bucket used a token class the matched row leaves unpriced (a null rate),
the whole bucket is treated as unpriced and counted in `missing_price_count` —
a used-but-unpriced class is never valued at zero.

### One currency, never summed across currencies

A summary reports a single `currency`, chosen deterministically as the currency
of the enabled price rows that matched the most contributing heartbeats (ties
broken by the lexicographically smallest code, else `USD`). Costs are never
summed across currencies: contributions priced in a different currency are
excluded from every `estimated_cost`, counted in `missing_price_count`, and the
summary sets `mixed_currency: true` to warn that some priced usage is not
reflected in the totals.

## Owner-managed pricing table

Estimated cost is only as good as the prices you configure. Price rows are
owner-scoped and effective-dated:

- `GET`/`POST /api/v1/users/current/ai/prices`
- `GET`/`PATCH`/`DELETE /api/v1/users/current/ai/prices/{price_id}`

Each row sets per-1,000,000-token rates for the six token classes (any subset),
a `currency` (`^[A-Z]{3}$`, default `USD`), an `[effective_from, effective_to)`
window, and an optional `http(s)` `source_url` documenting where the rate came
from. Rules:

- At least one rate is required; rates are `0..1e6`.
- `provider`, `model`, and `effective_from` are immutable — create a new row to
  change them.
- Enabled owner rows for the same `(provider, model)` may not have overlapping
  windows, so at most one enabled row matches any instant. Disabled rows may
  overlap freely.
- **Disable a row instead of deleting it** to keep historical estimates
  reproducible.
- Unknown, cross-user, and CloudTime-shipped default rows return `404` on the
  single-row endpoints so id existence is never leaked.

These are owner-private cost reads. Prefer `Authorization: Bearer <api_key>`
over `?api_key=` on the usage and price endpoints so the key is not exposed in
URLs or access logs, and the responses are sent `Cache-Control: no-store`.

## Dashboard

The dashboard **AI coding activity** panel shows the token/cost summary for the
trailing window: estimated cost, priced-heartbeat and total-token counts, the
average reported prompt length, a per-token-class breakdown, a daily token
trend, and a by-model table. When no enabled price row matches, the estimated
cost reads as unavailable rather than zero, and any excluded heartbeats are
called out.

**Manage AI pricing** (linked from the panel, or `/app/ai/prices`) provides
view/add/edit/disable/delete controls for the pricing table with effective-date
bounds. A row's `source_url` renders only as an `http(s)` link.

## Boundaries

CloudTime writes this feature from its own OpenAPI schema, specs, and tests. The
term "WakaTime-compatible" appears only in documentation to describe editor
client interoperability; it is never a code identifier, label, or brand. See
[implementation-boundaries.md](implementation-boundaries.md).
