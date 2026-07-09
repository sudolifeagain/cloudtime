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
the resolved span at 366 days, and return `400` beyond that. Bucketing uses the
resolved `timezone` (owner profile timezone by default).

**Rationale**: A hard cap plus indexed `(user_id, category, time)` reads keeps
the endpoint within budget without a cron pre-aggregate in the first cut; a cron
aggregate can be added later if needed without changing the contract.

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

**Answer**: Report a single `currency` for the summary and set `mixed_currency`
true when matched rows disagree; do not silently sum across currencies.

**Rationale**: Cross-currency summation would be meaningless; a flag keeps the
estimate honest.

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

## Open Questions (for PR2)

- Should PR2 ship a small set of versioned default price rows, or start empty and
  let owners populate the table? Either is contract-compatible; if shipped, rows
  must carry `source_url`, `effective_from`, and `is_default=true`.
- Should a cron pre-aggregate AI usage per day to further cut request-time cost,
  or is the bounded indexed read sufficient at expected single-user volumes?
