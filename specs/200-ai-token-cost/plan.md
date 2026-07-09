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

**PR2 (after PR1 merges)**: DB columns + pricing tables via migration `0007_*`,
ingestion validation/binding for single + bulk paths, cost aggregation, the
three AI endpoints, dashboard token/cost panel, price management UI, tests, and
user docs.

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers)
**Primary Dependencies**: Hono >= 4.9.7; existing generated OpenAPI types; Zod
for validation; existing D1/KV bindings. No new runtime dependency planned.
**Storage**: PR2 adds AI telemetry columns to `heartbeats` and a new
`ai_model_prices` table (user-scoped, effective-dated), plus targeted indexes.
No new tables in PR1.
**Testing**: Vitest + workers pool. PR2 should cover ingestion of representative
AI payloads (single + bulk), telemetry round-trip on `GET /heartbeats`, price
selection by provider/model/effective-date, missing-price behavior, user-scoped
overrides, range bounding, and owner-only access.
**Performance Goals**: Usage reads stay within the ~10ms request CPU budget by
bounding the range (<=366 days) and using indexed `(user_id, category, time)`
scans; bulk ingestion uses `db.batch()`.
**Constraints**: D1 bulk writes via `db.batch()`; incremental cron aggregation
where aggregation is added; no dynamic provider-price fetches at request time;
no prompt/response content stored; owner-only, never public.

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | PR1 updates OpenAPI before implementation and regenerates types. |
| II. Cloudflare-Native | PASS | Bounded indexed reads; `db.batch()` bulk ingest; no request-time external fetch. |
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
migrations/0007_ai_telemetry_and_prices.sql         # ADD: columns + ai_model_prices + indexes
src/db/schema.sql                                   # CHANGE: mirror migration
src/routes/heartbeats.ts                            # CHANGE: validate/bind/return AI fields
src/routes/ai.ts                                    # ADD: usage + prices handlers
src/index.ts                                        # CHANGE: mount ai router
src/utils/ai/pricing.ts                             # ADD: effective-price selection + cost calc
src/utils/ai/usage.ts                               # ADD: bounded aggregation builders
src/ui/app.tsx / dashboard                          # CHANGE: token/cost panel + price controls
tests/integration/ai-heartbeats.test.ts             # ADD: ingestion + round-trip
tests/integration/ai-usage.test.ts                  # ADD: summary + cost + range bounding
tests/aggregation/ai-pricing.test.ts                # ADD: price selection + missing price
docs/ai-usage.md                                    # ADD: client usage + estimate disclaimer
```

**Structure Decision**: Add a dedicated `/users/current/ai/*` router rather than
overloading heartbeats or stats, because usage/pricing are a distinct owner-only
analytics surface. Reuse the existing heartbeat ingestion path for AI fields so
compatible-client behavior stays a single wire surface. Keep pricing
effective-dated (append rows, never mutate historical rows) so estimates are
reproducible.

## Phases

- **PR1 - Spec + Design**: create this SpecKit set; extend `HeartbeatInput`; add
  AI schemas and `paths/ai/*`; register paths and the `ai` tag; run
  `npm run lint:api`, `npm run generate`, `npm run typecheck`, `npm test`; open
  a PR against `develop`.
- **PR2 - Implementation**: add migration + schema, ingestion binding, pricing
  selection + cost aggregation, the three endpoints, dashboard panel and price
  controls, tests, and docs; run `npm run typecheck && npm test`; open a PR
  referencing #200 and PR1.

## Risks & Mitigations

- **Unbounded usage scans blow the CPU budget** -> cap range at 366 days, index
  `(user_id, category, time)`, and return `400` on over-wide ranges.
- **Silent zero cost misleads** -> represent missing prices with
  `missing_price_count` and a `null` `estimated_cost` at every bucket level.
- **Historical estimates drift when prices change** -> prices are effective-dated
  and append-only; cost uses the row effective at each heartbeat's timestamp.
- **Provider prompt-cache classes collapse into one rate** -> model separate
  cached-input, cache-write, and cache-read rate columns.
- **Mixed-currency price rows sum incorrectly** -> report a single summary
  `currency` and flag `mixed_currency` when matched rows disagree.
- **Leaking price-id existence across users** -> cross-user/unknown ids return
  `404`, matching goals.
- **Trademark/boundary drift** -> AI analytics framed as CloudTime-original
  personal analytics; no third-party source, assets, or plan-tier copy.
