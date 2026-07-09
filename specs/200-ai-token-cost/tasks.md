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

- [ ] T101 Add migration `migrations/0007_ai_telemetry_and_prices.sql`: AI telemetry columns on `heartbeats`, the `ai_model_prices` table, and indexes; mirror in `src/db/schema.sql`.
- [ ] T102 Add `(user_id, category, time)` and pricing lookup indexes.

### User Story 1 - Ingest and return AI telemetry (P1)

- [ ] T103 [US1] Validate and bind AI telemetry fields in single and bulk heartbeat ingestion in `src/routes/heartbeats.ts` (bulk via `db.batch()`).
- [ ] T104 [US1] Include stored AI telemetry fields in `GET /users/current/heartbeats` responses.
- [ ] T105 [US1] Integration tests for single + bulk AI ingestion, round-trip, omitted-field compatibility, and `400` on malformed token values in `tests/integration/ai-heartbeats.test.ts`.

### User Story 3 - Owner-managed pricing table (P2, precedes cost in US2)

- [ ] T106 [US3] Implement `GET`/`POST /users/current/ai/prices` and `GET`/`PATCH`/`DELETE /users/current/ai/prices/{price_id}` in `src/routes/ai.ts`.
- [ ] T107 [US3] Enforce required fields, rate validation, immutable `provider`/`model`/`effective_from`, default-row protection, and cross-user `404`.
- [ ] T108 [US3] Unit tests for price selection by provider/model/effective date, missing-price behavior, and user-specific overrides in `tests/aggregation/ai-pricing.test.ts`.

### User Story 2 - Owner-only usage & cost summary (P1)

- [ ] T109 [US2] Implement effective-price selection and cost calculation in `src/utils/ai/pricing.ts`.
- [ ] T110 [US2] Implement bounded daily + dimensional aggregation builders in `src/utils/ai/usage.ts`.
- [ ] T111 [US2] Implement `GET /users/current/ai/usage` with range bounding (<=366 days), timezone bucketing, and owner-only access; mount the `ai` router in `src/index.ts`.
- [ ] T112 [US2] Integration tests for token trends, estimated cost with/without prices (`null` + `missing_price_count`), range bounding `400`, and owner-only `401` in `tests/integration/ai-usage.test.ts`.

### Dashboard & Docs

- [ ] T113 Update the dashboard AI coding panel to token/cost-aware summaries and add price view/add/edit/disable/date-bound controls.
- [ ] T114 Add `docs/ai-usage.md` describing compatible-client AI ingestion and the estimate (not-a-bill) disclaimer, following `docs/implementation-boundaries.md`.
- [ ] T115 Run `npm run typecheck && npm test`.
