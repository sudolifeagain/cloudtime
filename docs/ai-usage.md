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

### Deriving provider and model from the User-Agent

`ai_provider` and `ai_model` are optional. When an `ai coding` heartbeat omits
them, CloudTime fills them best-effort from the client User-Agent so per-provider
and per-model breakdowns work without the client changing its request body. An
explicit `ai_provider`/`ai_model` in the body always wins and is never
overwritten.

A compatible AI CLI composes a User-Agent whose tail lists the emitting plugin
and, where available, the active model, for example:

```
wakatime/<cli-ver> (<os>) <runtime> opus/4-8 claude-code/2.1.205 claude-code-wakatime/4.1.0
wakatime/<cli-ver> (<os>) <runtime> gpt-5.5/xhigh codex-cli/2.2.0 codex-cli-wakatime/1.1.0
```

CloudTime reads two things from it:

- **Provider** — from the `<tool>-wakatime` plugin token that identifies which
  tool emitted the heartbeat: `claude-code-wakatime` → `anthropic`,
  `codex-cli-wakatime` → `openai`.
- **Model** — from a recognized model token: an Anthropic `family/version`
  (`opus/4-8` → `claude-opus-4-8`) or an OpenAI model id
  (`gpt-5.5/xhigh` → `gpt-5.5`; the effort/detail after the slash is dropped).

The model is attributed **only for the resolved provider**, so a co-running
tool's token is never cross-attributed. A Codex heartbeat's User-Agent can still
carry Anthropic's `opus/4-8` because another assistant runs alongside; that token
is ignored, and the codex heartbeat resolves to `openai` with an OpenAI model
only if an OpenAI id such as `gpt-5.5/xhigh` is present.

**If your client does not send the model**, `ai_model` stays `null` and that
usage rolls up under an `unknown` model bucket (still attributed to the
provider). To get per-model breakdowns and cost, either send `ai_model`
explicitly in the heartbeat body, or have the client include the model as a
`<model>/<detail>` token in its plugin User-Agent as shown above.

> **Codex CLI:** the official `codex-cli-wakatime` plugin (through v1.0.0) does
> not emit the model, so Codex usage lands under an `unknown` model until patched.
> See [Codex model attribution](codex-model-attribution.md) for a reversible,
> version-guarded stopgap patch (`scripts/patch-codex-wakatime.mjs`).

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

## Shipped default prices

So a fresh instance estimates cost before anyone configures anything, CloudTime
ships a small **default price catalog** exposed as read-only `is_default` rows.
Defaults resolve by the *shape* of a model id rather than pinning every release,
so a steady stream of new models does not immediately go stale:

- **Anthropic** rates are flat within a family generation, so a default resolves
  from the family: `claude-opus-*` → $5/$25, `claude-sonnet-*` → $3/$15,
  `claude-haiku-*` → $1/$5, `claude-fable-*` / `claude-mythos-*` → $10/$50. A
  future `claude-opus-4-9` is priced with no code change; the price list shows
  these as family entries (`claude-opus-*`).
- **OpenAI** is priced per version, so its models are listed explicitly: `gpt-5`,
  `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.5`, and the three `gpt-5.6` tiers (Sol /
  Terra / Luna). An OpenAI model not in the list is left unpriced.

An owner price row always outranks the shipped default for the same
`(provider, model)`. A model no default covers stays unpriced and surfaces in
`missing_price_count` — never a silent zero — so you can add a row for it. The
catalog is code-maintained (no per-instance seeding or migration); its synthetic
`default:<provider>:<model>` ids are not individually addressable, so the
single-row price endpoints `404` on them.

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
