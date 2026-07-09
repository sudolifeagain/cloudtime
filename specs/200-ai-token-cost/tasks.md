# Tasks: AI Token Telemetry and Estimated Cost Trends

## PR1 - Spec + Design

- [x] T001 Capture GitHub Issue #200 scope and record clarifications (range bound, missing-price behavior, provider/model resolution, price mutability/deletion, currency handling) in `research.md`.
- [x] T002 Author SpecKit artifacts under `specs/200-ai-token-cost/` (spec, plan, research, data-model, quickstart, tasks, contracts, checklists).
- [x] T003 Extend `schemas/components/schemas/HeartbeatInput.yaml` with optional AI telemetry fields.
- [x] T004 Add `schemas/components/schemas/AITokenTotals.yaml` and `AIUsageSummary.yaml`.
- [x] T005 Add `schemas/components/schemas/AIModelPrice.yaml`, `AIModelPriceInput.yaml`, and `AIModelPriceUpdate.yaml`.
- [x] T006 Add `schemas/paths/ai/usage.yaml`, `prices.yaml`, and `price.yaml`.
- [x] T007 Register the three AI paths and add the `ai` tag in `schemas/openapi.yaml`.
- [x] T008 Run `npm run generate` (bundle + regenerate `src/types/generated.ts`).
- [x] T009 Run `npm run lint:api`.
- [x] T010 Run `npm run typecheck`.
- [x] T011 Run `npm test`.
- [x] T012 Commit in spec-first order and open a PR against `develop`.

## PR2 - Implementation

### Foundational

- [ ] T101 Add migration `migrations/0007_ai_telemetry_and_prices.sql`: AI telemetry columns on `heartbeats`, the `ai_model_prices` table, and the `ai_daily_usage` rollup table; mirror in `src/db/schema.sql`.
- [ ] T102 Add `(user_id, category, time)`, pricing lookup, and `ai_daily_usage(user_id, day)` indexes.

### User Story 1 - Ingest and return AI telemetry (P1)

- [ ] T103 [US1] Validate and bind AI telemetry fields in single and bulk heartbeat ingestion in `src/routes/heartbeats.ts` (bulk via `db.batch()`).
- [ ] T104 [US1] Include stored AI telemetry fields in `GET /users/current/heartbeats` responses.
- [ ] T105 [US1] Integration tests for single + bulk AI ingestion, round-trip, omitted-field compatibility, and `400` on malformed token values in `tests/integration/ai-heartbeats.test.ts`.

### User Story 3 - Owner-managed pricing table (P2, precedes cost in US2)

- [ ] T106 [US3] Implement `GET`/`POST /users/current/ai/prices` and `GET`/`PATCH`/`DELETE /users/current/ai/prices/{price_id}` in `src/routes/ai.ts`.
- [ ] T107 [US3] Enforce required fields, rate/value bounds (token `<=1e9`, rate `<=1e6`), `currency` `^[A-Z]{3}$`, `http(s)` `source_url`, immutable `provider`/`model`/`effective_from`, no overlapping enabled windows per default class, default-row protection, and cross-user `404`.
- [ ] T108 [US3] Unit tests for price selection by provider/model/effective date, owner-over-default precedence (FR-021), missing-price behavior, and user-specific overrides in `tests/aggregation/ai-pricing.test.ts`.

### User Story 2 - Owner-only usage & cost summary (P1)

- [ ] T109 [US2] Extend `src/cron/aggregate.ts` to incrementally build the `ai_daily_usage` rollup: resolve `provider`/`model`/`agent`, sum token classes per `(day, provider, model, agent, project)` via `db.batch()`, watermark-driven. Coalesce nullable `project` to a `''` sentinel before the UPSERT (as the existing summaries pass does) so the unique index dedups exactly. **Sum only `newHeartbeats` (`time > watermark`), never the prepended `lookbackHeartbeats`, or lookback tokens are re-added every run; extend the fetch SELECT to read the `ai_*` columns and `user_agent_id` (staying one scan) so the rollup `agent` dimension can be resolved from user-agent.**
- [ ] T110 [US2] Implement effective-price selection (owner-over-default precedence) and aggregate-then-price cost calculation in `src/utils/ai/pricing.ts`.
- [ ] T111 [US2] Implement rollup-based daily + dimensional aggregation builders, single-currency selection, and cross-currency exclusion in `src/utils/ai/usage.ts`.
- [ ] T112 [US2] Implement `GET /users/current/ai/usage` reading the `ai_daily_usage` rollup with deterministic range resolution (start+end vs days, `start>end`/one-sided/`>366d`/bad-timezone `400`), the `timezone` used only for range/"today" resolution and labeling (never re-bucketing stored days, FR-008), and owner-only access; mount the `ai` router in `src/index.ts`. Security seed: the usage/price routes inherit the API-wide `apiKeyQuery` scheme; prefer header/bearer auth on these owner-private cost reads and scrub `api_key` from access logs/Referer so credentials do not leak.
- [ ] T113 [US2] Integration tests for token trends, estimated cost with/without prices (`null` + `missing_price_count`), single-currency selection + `mixed_currency` exclusion, range resolution `400`s, and owner-only `401` in `tests/integration/ai-usage.test.ts`; rollup aggregation tests in `tests/aggregation/ai-rollup.test.ts`.

### Dashboard & Docs

- [ ] T114 Update the dashboard AI coding panel to token/cost-aware summaries and add price view/add/edit/disable/date-bound controls (render `source_url` as an `http(s)`-only link).
- [ ] T115 Add `docs/ai-usage.md` describing compatible-client AI ingestion and the estimate (not-a-bill) disclaimer, following `docs/implementation-boundaries.md`.
- [ ] T116 Run `npm run typecheck && npm test`.
