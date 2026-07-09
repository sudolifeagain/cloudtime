# Implementation Plan: AI Token Telemetry and Estimated Cost Trends

**Branch**: `200-ai-token-cost` | **Date**: 2026-07-09 | **Spec**: [spec.md](./spec.md)
**Input**: GitHub Issue #200

## Summary

Accept AI-specific heartbeat telemetry (tokens, prompt length, session, plan,
provider/model) spec-first, store it, and expose an owner-only usage summary
with daily token trends and API-equivalent estimated cost broken down by
project, agent/tool, provider, and model. Cost is computed from an owner-managed,
effective-dated pricing table, never from provider billing, and is explicitly
labeled an estimate. Missing prices surface as `missing_price_count` plus a
`null` cost rather than a silent zero.

**PR1 (this PR)**: SpecKit artifacts, OpenAPI schema/path changes, and
regenerated types. **No route handlers, migrations, `schema.sql` changes, or
dashboard code.**

**PR2 (after PR1 merges)**: DB columns + pricing table + a cron-maintained
`ai_daily_usage` rollup via migration `0007_*`, ingestion validation/binding for
single + bulk paths, incremental cron aggregation of the AI rollup,
aggregate-then-price cost computation, the three AI endpoints (usage reads the
rollup, never raw heartbeats), dashboard token/cost panel, price management UI,
tests, and user docs.

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers)
**Primary Dependencies**: Hono >= 4.9.7; existing generated OpenAPI types; Zod
for validation; existing D1/KV bindings. No new runtime dependency planned.
**Storage**: PR2 adds AI telemetry columns to `heartbeats`, a user-scoped
effective-dated `ai_model_prices` table, and a cron-maintained `ai_daily_usage`
rollup keyed by `(user_id, day, provider, model, agent, project)`, plus targeted
indexes. No new tables in PR1.
**Testing**: Vitest + workers pool. PR2 should cover ingestion of representative
AI payloads (single + bulk), telemetry round-trip on `GET /heartbeats`,
incremental rollup aggregation, price selection by provider/model/effective-date
with owner-over-default precedence, missing-price behavior, single-currency
selection + cross-currency exclusion, user-scoped overrides, range bounding, and
owner-only access.
**Performance Goals**: Usage reads stay within the ~10ms request CPU budget by
reading the cron-built `ai_daily_usage` rollup (aggregate-then-price, one price
lookup per bucket) over a bounded (<=366-day) range, never scanning raw
heartbeats at request time; bulk ingestion and rollup writes use `db.batch()`.
**Constraints**: D1 bulk writes via `db.batch()`; incremental cron aggregation
(watermark-driven) builds the AI rollup; no request-time raw-heartbeat scans and
no dynamic provider-price fetches at request time; no prompt/response content
stored; owner-only, never public.

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | PR1 updates OpenAPI before implementation and regenerates types. |
| II. Cloudflare-Native | PASS | Cron-built `ai_daily_usage` rollup read at request time (no raw scan); `db.batch()` bulk ingest + rollup writes; no request-time external fetch. |
| III. Type Safety | PASS | New contracts are generated from OpenAPI; `generated.ts` never hand-edited. |
| IV. Legal/Trademark | PASS | CloudTime-original AI analytics; `WakaTime-compatible` only in docs; no third-party source/assets. |
| V. Simplicity First | PASS | One summary endpoint + one pricing CRUD surface; owner-only; teams deferred. |

## Project Structure

### Documentation (this feature)

```text
specs/200-ai-token-cost/
|-- plan.md
|-- spec.md
|-- research.md
|-- data-model.md
|-- quickstart.md
|-- tasks.md
|-- contracts/
|   `-- openapi-diff.md
`-- checklists/
    `-- requirements.md
```

### Source Code (repository root)

```text
# PR1
schemas/components/schemas/HeartbeatInput.yaml      # CHANGE: add AI telemetry fields
schemas/components/schemas/AITokenTotals.yaml       # ADD: reusable token totals + estimated cost
schemas/components/schemas/AIUsageSummary.yaml      # ADD: owner-only usage summary
schemas/components/schemas/AIModelPrice.yaml        # ADD: effective-dated price row
schemas/components/schemas/AIModelPriceInput.yaml   # ADD: price create body
schemas/components/schemas/AIModelPriceUpdate.yaml  # ADD: price patch body
schemas/paths/ai/usage.yaml                         # ADD: GET usage summary
schemas/paths/ai/prices.yaml                        # ADD: GET list / POST create
schemas/paths/ai/price.yaml                         # ADD: GET / PATCH / DELETE by id
schemas/openapi.yaml                                # CHANGE: register paths + `ai` tag
src/types/generated.ts                              # REGENERATED

# PR2 (after PR1 merges)
migrations/0007_ai_telemetry_and_prices.sql         # ADD: columns + ai_model_prices + ai_daily_usage rollup + indexes
src/db/schema.sql                                   # CHANGE: mirror migration
src/routes/heartbeats.ts                            # CHANGE: validate/bind/return AI fields
src/cron/aggregate.ts                               # CHANGE: incrementally build ai_daily_usage (resolve provider/model/agent, db.batch())
src/routes/ai.ts                                    # ADD: usage (reads rollup) + prices handlers
src/index.ts                                        # CHANGE: mount ai router
src/utils/ai/pricing.ts                             # ADD: effective-price selection (owner-over-default precedence) + cost calc
src/utils/ai/usage.ts                               # ADD: rollup-based aggregation + currency selection builders
src/ui/app.tsx / dashboard                          # CHANGE: token/cost panel + price controls
tests/integration/ai-heartbeats.test.ts             # ADD: ingestion + round-trip
tests/integration/ai-usage.test.ts                  # ADD: summary + cost + currency + range bounding
tests/aggregation/ai-pricing.test.ts                # ADD: price selection/precedence + missing price
tests/aggregation/ai-rollup.test.ts                 # ADD: incremental daily rollup aggregation
docs/ai-usage.md                                    # ADD: client usage + estimate disclaimer
```

**Structure Decision**: Add a dedicated `/users/current/ai/*` router rather than
overloading heartbeats or stats, because usage/pricing are a distinct owner-only
analytics surface. Reuse the existing heartbeat ingestion path for AI fields so
compatible-client behavior stays a single wire surface. Serve `/ai/usage` from a
cron-maintained `ai_daily_usage` rollup (aggregate-then-price) rather than
scanning raw heartbeats, matching the existing summary/hourly rollup
architecture. Keep pricing effective-dated (append rows, never mutate historical
rows) with deterministic owner-over-default selection so estimates are
reproducible.

## Phases

- **PR1 - Spec + Design**: create this SpecKit set; extend `HeartbeatInput`; add
  AI schemas and `paths/ai/*`; register paths and the `ai` tag; run
  `npm run lint:api`, `npm run generate`, `npm run typecheck`, `npm test`; open
  a PR against `develop`.
- **PR2 - Implementation**: add migration + schema (columns, `ai_model_prices`,
  `ai_daily_usage` rollup), ingestion binding, incremental cron aggregation of
  the AI rollup, deterministic pricing selection + aggregate-then-price cost, the
  three endpoints, dashboard panel and price controls, tests, and docs; run
  `npm run typecheck && npm test`; open a PR referencing #200 and PR1.

## Risks & Mitigations

- **Request-time raw scans blow the CPU/row budget** -> `/ai/usage` reads the
  cron-built `ai_daily_usage` rollup (aggregate-then-price), never raw
  heartbeats; range is still capped at 366 days and returns `400` beyond.
- **Silent zero cost misleads** -> represent missing prices with
  `missing_price_count` and a `null` `estimated_cost` at every bucket level.
- **Non-deterministic price selection** -> deterministic precedence
  (owner-over-default, then latest `effective_from`) plus a write-time ban on
  overlapping enabled windows per default class.
- **Historical estimates drift when prices change** -> prices are effective-dated
  and append-only; cost uses the row effective at each bucket's day.
- **Provider prompt-cache classes collapse into one rate** -> model separate
  cached-input, cache-write, and cache-read rate columns.
- **Mixed-currency price rows sum incorrectly** -> pick one summary `currency`
  deterministically, never sum across currencies (off-currency contributions go
  to `missing_price_count`), and flag `mixed_currency`.
- **Garbage token/rate values overflow aggregates** -> schema caps (token/length
  `<= 1e9`, rate `<= 1e6`, `400` on violation) + double-precision cost sums.
- **Leaking price-id existence across users** -> cross-user/unknown ids return
  `404`, matching goals.
- **Trademark/boundary drift** -> AI analytics framed as CloudTime-original
  personal analytics; no third-party source, assets, or plan-tier copy.
