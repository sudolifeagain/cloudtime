# Research: AI Token Telemetry and Estimated Cost Trends

**Research Date**: 2026-07-09
**Feature**: AI token telemetry ingestion and owner-only estimated cost trends

## Sources Consulted

Only public documentation and behavior observed from a user-owned local setup
were used. No third-party product source code, visual assets, or product copy
were consulted.

- OpenAI pricing (input / cached input / output per 1M tokens):
  `https://developers.openai.com/api/docs/pricing` and
  `https://openai.com/api/pricing/`
- Anthropic / Claude pricing, including prompt-cache write/read classes:
  `https://platform.claude.com/docs/en/about-claude/pricing`
- Claude prompt caching (distinct cache-write vs cache-hit multipliers):
  `https://platform.claude.com/docs/en/build-with-claude/prompt-caching`
- Claude Code cost tracking (client-side cost is an estimate; authoritative
  billing uses provider usage/cost APIs):
  `https://code.claude.com/docs/en/agent-sdk/cost-tracking`
- Claude Code / Codex telemetry emit token counts on completion (OpenTelemetry):
  `https://code.claude.com/docs/en/monitoring-usage`,
  `https://developers.openai.com/codex/config-advanced#observability-and-telemetry`
- CloudTime `docs/compatibility-research.md` and
  `docs/implementation-boundaries.md` for framing and naming constraints.

## Decision 1: Extend heartbeat ingestion, no new wire surface

**Decision**: Add optional AI telemetry to `HeartbeatInput` and reuse the
existing single/bulk heartbeat endpoints.

**Rationale**: Observed compatible clients already send AI fields on
`POST /users/current/heartbeats.bulk` with `category: "ai coding"`. Adding a
second ingestion path would fork the wire contract for no benefit.

**Alternatives considered**: A dedicated AI ingestion endpoint. Rejected because
it would duplicate validation, batching, and machine/user-agent handling.

## Decision 2: Provider-neutral token classes

**Decision**: Model input, cached input, output, reasoning output, cache write,
and cache read as separate optional token fields and price classes.

**Rationale**: OpenAI and Anthropic price cached and reasoning tokens
differently, and Claude prompt caching uses distinct write/read multipliers.
Collapsing everything into one input rate would misestimate cost.

**Alternatives considered**: A single input/output pair. Rejected as too coarse
to represent documented provider pricing.

## Decision 3: Owner-managed, effective-dated pricing table

**Decision**: Store rates in `ai_model_prices`, keyed by `(user_id, provider,
model, effective_from)`, append-only, with `effective_to`, `source_url`,
`is_default`, and `is_enabled`.

**Rationale**: Provider prices change over time; owners need custom/local model
rates. Effective-dating keeps historical estimates reproducible by computing
cost from the row effective at each heartbeat's timestamp.

**Alternatives considered**: Mutating a single current-rate row per model.
Rejected because it silently rewrites historical cost estimates.

## Decision 4 (Clarification): Range bounding

**Question**: How wide can the usage range be, given the ~10ms request CPU
budget?

**Answer**: Accept `start`+`end` or a trailing `days` window (default 30), cap
the resolved span at 366 days, and return `400` beyond that. `start`+`end` takes
precedence over `days`; supplying exactly one of them is `400`, as is `start >
end` or an invalid `timezone`. Bucketing uses the resolved `timezone` (owner
profile timezone by default).

**Rationale**: A hard cap bounds the calendar range, but the cap alone does not
bound *row volume* or the effective-dated price join. To respect the binding
Cloudflare "offload heavy work to Cron / incremental aggregation" constraint,
`/ai/usage` reads a cron-maintained daily rollup (`ai_daily_usage`) rather than
scanning raw heartbeats at request time — see Decision 11. The 366-day cap then
bounds the number of *rollup* rows read.

## Decision 5 (Clarification): Missing-price behavior

**Question**: What is returned when no price row matches a heartbeat?

**Answer**: Count the heartbeat in `missing_price_count` and exclude it from the
cost sum; return `estimated_cost: null` for any bucket where no contributing
heartbeat matched. Never report a silent zero.

**Rationale**: The issue requires that missing pricing is visible and not
mistaken for free usage.

## Decision 6 (Clarification): Provider/model resolution

**Question**: Where do provider and model come from when the client omits them?

**Answer**: Prefer explicit `ai_provider` / `ai_model` payload fields; otherwise
derive best-effort from stored user-agent metadata; otherwise label `unknown`.
Raw user-agent rows are preserved.

**Rationale**: Compatible clients do not consistently send provider/model, but
grouping still needs a value; best-effort derivation avoids dropping data.

## Decision 7 (Clarification): Price mutability and deletion

**Question**: Which price fields are mutable, and can rows be deleted?

**Answer**: `provider`, `model`, and `effective_from` are immutable (mirrors the
immutable `type`/`delta` on goals); other fields are patchable. `DELETE`
hard-removes an owner-created row but disabling via `is_enabled=false` is
preferred to preserve reproducibility. CloudTime-shipped default rows
(`is_default=true`) cannot be edited or deleted (`404`); owners disable or
supersede them.

**Rationale**: Immutable identity keeps historical estimates stable; owner-only
scoping and `404`-on-cross-user match the goals precedent.

## Decision 8 (Clarification): Currency handling

**Question**: How are multiple currencies handled in one summary?

**Answer**: Report a single summary `currency`, chosen deterministically as the
currency of the enabled price rows matching the most contributing heartbeats in
the range (ties → lexicographically smallest ISO code; default `USD` when
nothing matched). Never sum across currencies: contributions whose matched price
row uses a different currency are excluded from `estimated_cost` and counted in
`missing_price_count`, and `mixed_currency` is set true to warn that some priced
usage is not reflected in the totals.

**Rationale**: Cross-currency summation would be meaningless. Excluding
off-currency contributions (rather than combining them "indicatively") keeps
every reported number honest and reproducible, and the flag plus
`missing_price_count` make the exclusion visible. This closes the earlier schema
wording that implied costs "may combine currencies."

## Decision 9: Owner-only, never public

**Decision**: All AI usage and cost endpoints are authenticated `/users/current`
routes; nothing is exposed through public cards/badges.

**Rationale**: The issue forbids public exposure of AI usage/cost. In single-user
mode the authenticated user is the owner, so `authMiddleware` is the owner gate.

## Decision 10: Keep PR1 implementation-free

**Decision**: PR1 includes only SpecKit artifacts, OpenAPI changes, and generated
types.

**Rationale**: The project uses the two-PR SpecKit workflow; storage, ingestion,
aggregation, and UI land in PR2 after the contract is agreed.

## Decision 11: Cron daily rollup, aggregate-then-price

**Decision**: `/ai/usage` reads a cron-maintained daily rollup table
(`ai_daily_usage`) keyed by `(user_id, day, provider, model, agent, project)`;
it does not scan raw `heartbeats` at request time. `provider`/`model`/`agent`
are resolved at ingestion/aggregation and stored on the rollup; the effective
price is resolved once per bucket (aggregate-then-price), not per heartbeat.

**Rationale**: Every existing multi-day analytics endpoint (`summaries.ts`,
`stats.ts`, `insights.ts`) reads cron rollups, and raw heartbeats are scanned
only in the incremental cron (`cron/aggregate.ts`, `db.batch()`). A request-time
scan with a per-row effective-dated price join over up to 366 days of raw rows
would violate the ~10ms CPU budget and risk the D1 row-read budget. This is
contract-neutral (no OpenAPI change) and binds PR2's storage/cron design.

**Alternatives considered**: Request-time bounded indexed scan of raw
heartbeats. Rejected: the calendar cap does not bound row volume, and the as-of
price join is non-indexable.

## Decision 12: Deterministic price precedence

**Decision**: When more than one enabled price row matches a heartbeat's
`(provider, model)` and timestamp — legitimately possible when an owner row and
a still-enabled default row coexist — select **owner over default, then latest
`effective_from`**. PR2 additionally forbids overlapping enabled windows within
one default class per `(user_id, provider, model)`.

**Rationale**: Effective-dating exists to make historical estimates
reproducible; without a tie-break two matching rows make cost non-deterministic.
Owner-over-default matches FR-014 ("owners supersede default rows").

## Decision 13: Bounded token/rate values

**Decision**: Cap AI token/length fields at 1e9 and per-1M-token rates at 1e6 in
the schema (`400` on violation), and accumulate token sums as bounded integers
with cost as a double.

**Rationale**: `estimated_cost = Σ(token × rate)/1e6`; an unbounded garbage token
count from a buggy client would corrupt every aggregate it touches. The caps are
far above any real interaction/rate yet keep products within safe numeric range.

## Open Questions (for PR2)

- Should PR2 ship a small set of versioned default price rows, or start empty and
  let owners populate the table? Either is contract-compatible; if shipped, rows
  are seeded **per user** (Decision + FR-024) carrying `source_url`,
  `effective_from`, and `is_default=true`.
- Resolved: cron daily pre-aggregation is now **required** (Decision 11), not
  optional, so PR2 does not ship a request-time raw scan.
