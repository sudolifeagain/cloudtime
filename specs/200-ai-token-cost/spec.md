# Feature Specification: AI Token Telemetry and Estimated Cost Trends

**Feature Branch**: `200-ai-token-cost`
**Created**: 2026-07-09
**Status**: Draft
**Input**: GitHub Issue #200

## User Stories & Testing

### User Story 1 - Ingest and return AI token telemetry (Priority: P1)

As a CloudTime owner, I want AI-specific telemetry sent by my WakaTime-compatible
client (token counts, prompt length, session, plan, provider/model) to be stored
and returned, so that later analytics have real token facts instead of only
heartbeat counts.

**Why this priority**: Without persisting the fields the client already sends,
every downstream token and cost analytic is impossible. Capturing them is the
foundation for the rest of the feature and is a self-contained increment.

**Independent Test**: Send single and bulk `ai coding` heartbeats containing
`ai_input_tokens`, `ai_output_tokens`, `ai_session`, `ai_subscription_plan`, and
`ai_prompt_length`; confirm `GET /users/current/heartbeats?date=...` returns the
stored values, and that heartbeats omitting the fields still succeed unchanged.

**Acceptance Scenarios**:

1. Given a valid `ai coding` heartbeat carrying token fields, when it is posted
   to `POST /users/current/heartbeats`, then it is accepted and the fields are
   persisted.
2. Given a bulk request mixing heartbeats with and without token fields, when it
   is posted to `POST /users/current/heartbeats.bulk`, then each item is stored
   with its own token fields and per-item response semantics are preserved.
3. Given stored AI heartbeats, when the owner requests
   `GET /users/current/heartbeats?date=...`, then the response includes the
   stored AI telemetry fields.
4. Given a heartbeat with a negative or non-integer token value, when it is
   posted, then the request returns `400` consistently with existing heartbeat
   validation.

---

### User Story 2 - Owner-only AI usage and estimated cost summary (Priority: P1)

As a CloudTime owner, I want a bounded usage summary that shows daily token
trends and estimated API-equivalent cost broken down by project, AI agent/tool,
provider, and model, so that I can understand my AI coding usage over time.

**Why this priority**: The token/cost summary is the headline value of the
feature. Token trends are useful even before any pricing is configured, and the
summary degrades gracefully to a `null` estimated cost rather than a misleading
zero.

**Independent Test**: With AI heartbeats stored, request
`GET /users/current/ai/usage?days=30` and verify the response returns daily token
totals plus `by_project`, `by_agent`, `by_provider`, and `by_model` breakdowns,
each with token totals and an `estimated_cost` that is `null` (with
`missing_price_count` > 0) when no price row matches.

**Acceptance Scenarios**:

1. Given stored AI heartbeats and no pricing rows, when the owner requests
   `GET /users/current/ai/usage`, then token trends and breakdowns are returned
   and `estimated_cost` is `null` with a non-zero `missing_price_count`.
2. Given stored AI heartbeats and matching enabled pricing rows, when the owner
   requests the summary, then `estimated_cost` is a positive estimate derived
   from the rollup's aggregated tokens and the effective price resolved once per
   daily bucket (aggregate-then-price).
3. Given a requested range wider than 366 days, when the summary is requested,
   then the response is `400`.
4. Given no authenticated owner, when `GET /users/current/ai/usage` is requested,
   then the response is `401` and no AI usage or cost is disclosed.

---

### User Story 3 - Owner-managed effective-dated pricing table (Priority: P2)

As a CloudTime owner, I want to create, edit, disable, and date-bound AI model
price rows, so that estimated costs use rates I control and historical estimates
stay reproducible.

**Why this priority**: Pricing enriches the summary's cost estimates but is not
required for token trends. It is a distinct management surface that can be built
and tested independently.

**Independent Test**: Create a price row via `POST /users/current/ai/prices`,
list it, update a rate via `PATCH`, disable it, and confirm a
different-user/unknown id returns `404`.

**Acceptance Scenarios**:

1. Given the owner, when they `POST` a valid price row, then it is created with
   `is_default=false` and returned in the `AIModelPrice` shape.
2. Given an existing owner price row, when the owner `PATCH`es a rate or sets
   `is_enabled=false`, then the change is applied and the row is returned.
3. Given a price row created by another user or an unknown id, when the owner
   requests, updates, or deletes it, then the response is `404`.
4. Given a `POST` with no rate field, or `effective_to` not strictly after
   `effective_from`, or an immutable field in a `PATCH`, then the response is
   `400`.

## Requirements

### Functional Requirements

- **FR-001**: `HeartbeatInput` MUST add optional AI telemetry fields:
  `ai_session`, `ai_subscription_plan`, `ai_prompt_length`, `ai_input_tokens`,
  `ai_output_tokens`, `ai_cached_input_tokens`, `ai_reasoning_output_tokens`,
  `ai_cache_write_tokens`, `ai_cache_read_tokens`, `ai_provider`, and `ai_model`.
- **FR-002**: All new token/length fields MUST be optional non-negative
  integers; string fields MUST be bounded by `maxLength`.
- **FR-003**: Because `Heartbeat` is `allOf` of `HeartbeatInput`, `Heartbeat`
  responses MUST include the stored AI telemetry fields for the owner.
- **FR-004**: Malformed AI telemetry (negative, non-integer, or over-length)
  MUST return `400`, consistent with existing heartbeat validation.
- **FR-005**: Heartbeats that omit AI telemetry fields MUST continue to be
  accepted unchanged for both single and bulk paths.
- **FR-006**: The API MUST add an owner-only summary endpoint
  `GET /users/current/ai/usage`.
- **FR-007**: The usage summary MUST return a daily token trend and breakdowns
  by project, AI agent/tool, provider, and model, each with token totals and an
  `estimated_cost`.
- **FR-008**: The usage range MUST be bounded and resolved deterministically.
  When both `start` and `end` are supplied the explicit inclusive range is used
  and `days` is ignored; supplying exactly one of `start`/`end` MUST return
  `400`; otherwise a trailing `days` window (default 30) ending on the current
  local day is used. The resolved `timezone` (owner profile timezone by default)
  governs only how "today" and the `start`/`end` calendar days are resolved for
  range selection and how the window is labeled; it MUST NOT re-bucket historical
  days at read time. Day boundaries are materialized once at aggregation time in a
  fixed *aggregation timezone* — defined as the owner's profile timezone — and are
  read back by day key (FR-025), consistent with the existing `summaries` rollup,
  which likewise uses `timezone` only for range selection and labeling, never to
  re-bucket already-aggregated days. A `timezone` differing from the aggregation
  timezone therefore shifts only the range endpoints, not the internal day
  boundaries. The endpoint MUST return `400` when `start > end`, when the resolved
  span exceeds 366 days — the span is an inclusive day count, so `start == end`
  is a one-day span and a 366-day inclusive window is the maximum, matching
  `days`'s `maximum: 366` — or when `timezone` is not a valid IANA name.
- **FR-009**: `estimated_cost` MUST be an API-equivalent estimate derived from
  the rollup's aggregated token counts and the effective enabled price row
  resolved once per rollup bucket at day granularity (aggregate-then-price per
  FR-025) — the row whose `[effective_from, effective_to)` window contains the
  bucket day's start-of-day instant in the fixed aggregation timezone, not each
  heartbeat's individual timestamp; it MUST NOT be presented as an actual
  subscription bill.
- **FR-010**: When no enabled price row in the summary `currency` *fully prices*
  a contributing heartbeat's bucket — no row matched its `(provider, model)`, the
  matched row is a different currency, or the matched row leaves a token class the
  bucket used unpriced (a null rate) — that heartbeat MUST count toward
  `missing_price_count` and be excluded from the cost sum; `estimated_cost` MUST
  be `null` (never a silent zero) when no contributing heartbeat falls in a
  fully-priced bucket in the summary `currency`. A price row prices only the token
  classes for which it defines a rate, so a row that leaves a nonzero class
  unpriced does not fully price the bucket (a used-but-unpriced class is never
  silently valued at zero).
- **FR-011**: The API MUST add owner-only pricing endpoints:
  `GET`/`POST /users/current/ai/prices` and
  `GET`/`PATCH`/`DELETE /users/current/ai/prices/{price_id}`.
- **FR-012**: A price row (`AIModelPrice`) MUST be effective-dated with
  `effective_from` and optional `effective_to`, carry per-1M-token rates across
  the input, cached input, output, reasoning output, cache write, and cache read
  classes (at least one of which MUST be present), and include `currency`,
  `source_url`, `is_default`, and `is_enabled`.
- **FR-013**: `provider`, `model`, and `effective_from` MUST be immutable after
  creation (changing them returns `400`); owners supersede rows by creating new
  ones or toggling `is_enabled`.
- **FR-014**: CloudTime-shipped default rows (`is_default=true`) MUST NOT be
  edited or deleted through the owner endpoints (return `404`); they MAY be
  disabled or superseded by owner rows.
- **FR-015**: Cross-user or unknown price ids MUST return `404` (not `403`) to
  avoid leaking id existence, consistent with goals.
- **FR-016**: AI usage and estimated cost MUST NOT be exposed through public
  cards, badges, or any unauthenticated endpoint.
- **FR-017**: The feature MUST NOT store prompt or response content; only
  numeric token facts and short opaque identifiers are retained.
- **FR-018**: AI agent/tool MUST be derived best-effort from stored user-agent
  metadata (the editor/plugin identifier already captured on each heartbeat),
  with unresolved rows labeled `unknown`; raw user-agent rows MUST be preserved.
  (No dedicated `ai_agent` wire field is added. Per FR-025 the agent is resolved
  from the stored user-agent at aggregation time and stored on the daily rollup —
  it is never parsed per row at read time.)
- **FR-019**: All feature naming (routes, schemas, identifiers, docs) MUST follow
  `docs/implementation-boundaries.md`; third-party names appear only as
  `WakaTime-compatible` wording in documentation.
- **FR-020**: PR1 MUST include only SpecKit artifacts, OpenAPI changes, and
  regenerated OpenAPI types. It MUST NOT include route handlers, migrations,
  `schema.sql` changes, dashboard code, or docs behavior changes.
- **FR-021**: When more than one enabled price row matches a rollup bucket's
  `(provider, model)` at its resolution instant — the bucket day's start-of-day
  in the fixed aggregation timezone (FR-025) — (e.g. an owner row and a
  still-enabled default row), price selection MUST be deterministic: prefer the
  owner row
  (`is_default=false`) over the default row, then the row with the latest
  `effective_from`. PR2 MUST additionally forbid two enabled rows of the same
  default class from having overlapping effective windows for one
  `(user_id, provider, model)`, so estimated cost is reproducible.
- **FR-022**: The usage summary MUST report a single `currency`, chosen
  deterministically as the currency of the enabled price rows matching the most
  contributing heartbeats in the range (ties broken by the lexicographically
  smallest ISO code; defaulting to `USD` when nothing matched). Costs MUST NOT be
  summed across currencies: contributions whose matched price row uses a
  different currency MUST be excluded from `estimated_cost` and counted in
  `missing_price_count`, and `mixed_currency` MUST be set true.
- **FR-023**: AI token/length fields and price rate fields MUST be bounded
  (token/length ≤ 1e9, per-1M-token rates ≤ 1e6) so a malformed client cannot
  overflow or corrupt cost aggregates; out-of-range values MUST return `400`.
- **FR-024**: `is_default` price rows MUST remain coherent with the repo's
  per-user (`user_id NOT NULL`) table convention. When PR2 ships default rows it
  MUST seed them per user (one owner-scoped copy per user, `is_default=true`,
  read-only via the owner endpoints) so the user-scoped price lookup stays a
  simple `WHERE user_id = ?` with no global/nullable-owner special case.
- **FR-025**: The usage summary MUST be served from an incremental,
  cron-maintained daily AI usage rollup (consistent with the existing
  summary/hourly rollup architecture), aggregating token classes per
  `(day, provider, model, agent, project)` and resolving the effective price once
  per bucket (aggregate-then-price). The rollup's `day` key MUST be materialized
  in the fixed aggregation timezone (the owner's profile timezone), exactly as
  `summaries` builds its `date` key, so day boundaries are stable and never
  recomputed against a request `timezone` (FR-008). Provider/model/agent MUST be
  resolved at ingestion/aggregation time and stored on the rollup, never parsed
  per-row at read time. This requirement is contract-neutral (no OpenAPI change)
  and binds PR2's storage/cron design only.
- **FR-026**: A *contributing heartbeat* is defined as one with
  `category: "ai coding"` carrying at least one priced token field; heartbeats
  with only `ai_prompt_length` and no priced token field MUST NOT contribute to
  any token total, `heartbeat_count`, or `missing_price_count`. "Carrying" a
  priced token field is decided by presence, not value: a heartbeat sending
  `ai_input_tokens: 0` (field present, value `0`) IS a contributing heartbeat and
  counts toward `heartbeat_count` (and `missing_price_count` when no price row
  matches), whereas a heartbeat that omits every priced token field does not.

### Entities

- **AI Heartbeat Telemetry**: Optional token/session/prompt/provider/model fields
  attached to an existing heartbeat; numeric facts only.
- **AI Model Price**: An owner-scoped, effective-dated rate table row used to
  estimate API-equivalent cost from stored token facts.
- **AI Usage Summary**: A bounded, owner-only aggregation of token facts and
  derived estimated cost with daily and dimensional breakdowns.

## Success Criteria

- **SC-001**: A heartbeat carrying the documented AI token fields is accepted,
  persisted, and returned to the owner.
- **SC-002**: The owner can retrieve a bounded daily token trend and estimated
  cost broken down by project, agent, provider, and model.
- **SC-003**: Missing pricing is visible via `missing_price_count` and a `null`
  `estimated_cost`; no path silently reports zero cost.
- **SC-004**: The owner can create, edit, disable, and date-bound price rows, and
  cross-user access returns `404`.
- **SC-005**: AI usage and cost are never reachable without authentication.
- **SC-006**: The OpenAPI contract generates TypeScript types without manual
  edits.

## Assumptions

- In single-user mode the one authenticated user is the owner; `authMiddleware`
  on `/users/current/*` is the owner gate, so no new role guard is added.
- Compatible clients send AI fields on the existing bulk/single heartbeat
  endpoints; CloudTime does not add a new ingestion surface.
- Token facts are sufficient for API-equivalent cost; provider account
  reconciliation and authoritative billing are out of scope.
- Shipping versioned default price rows in PR2 is optional; when shipped they
  carry `source_url`, `effective_from`, and `is_default=true`, are seeded per
  user (FR-024), and remain owner-overridable (disable or supersede).

## Out of Scope

- Authoritative billing, invoicing, payments, budget enforcement, or provider
  account reconciliation.
- A new local collector / `cloudtime-agent` repository.
- Dynamic fetching of provider prices from Workers at request time.
- Public or unauthenticated exposure of AI usage or cost.
- Storing prompt or response content.
- Team dashboards, private leaderboards, organizations, or other multi-user
  features.
- Implementation code in PR1.
