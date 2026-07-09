# Requirements Checklist: AI Token Telemetry and Estimated Cost Trends

## Specification Quality

- [x] User stories are independently testable.
- [x] Functional requirements are numbered and verifiable.
- [x] Estimate-not-a-bill semantics are explicit.
- [x] Missing-price behavior (null cost + `missing_price_count`) is explicit.
- [x] Owner-only / no-public-exposure behavior is explicit.
- [x] No prompt/response content is stored.
- [x] Legal/implementation boundaries are referenced.
- [x] Team and multi-user work is out of scope.
- [x] PR1 excludes implementation code, migrations, and dashboard changes.

## Contract Coverage

- [x] Optional AI telemetry fields added to `HeartbeatInput` and flow to
      `Heartbeat` responses.
- [x] Token fields are optional and non-negative; malformed values return `400`.
- [x] Usage summary path, bounded range, and breakdowns are defined.
- [x] Usage summary carries token totals and `estimated_cost` by day, project,
      agent, provider, and model.
- [x] Pricing CRUD paths are defined (list/create/read/update/delete).
- [x] Effective-dated rate classes cover input, cached input, output, reasoning
      output, cache write, and cache read.
- [x] Immutable `provider`/`model`/`effective_from`, default-row protection, and
      cross-user `404` are specified.
- [x] Multi-matching price rows resolve deterministically (owner-over-default,
      then latest `effective_from`; no overlapping enabled windows) — FR-021.
- [x] Single summary `currency` selection is defined and costs are never summed
      across currencies (off-currency → `missing_price_count`) — FR-022.
- [x] `by_agent` is derived from user-agent only; no phantom wire field — FR-018.
- [x] Token/rate values are bounded; malformed values return `400` — FR-023.
- [x] `is_default` rows stay per-user coherent (seeded per user) — FR-024.
- [x] Range input resolution and `400` conditions are enumerated — FR-008.
- [x] Error behavior covers `400`, `401`, and `404` (incl. list `400`).
- [x] Changes are additive; existing paths/schemas are unchanged.

## Cloudflare Constraints

- [x] Usage range is bounded (<=366 days) for the request CPU budget.
- [x] `/ai/usage` reads a cron-built `ai_daily_usage` rollup (aggregate-then-
      price), never scanning raw heartbeats at request time — FR-025.
- [x] Bulk ingestion and rollup writes use `db.batch()` (PR2).
- [x] Cron AI aggregation is incremental (watermark-driven).
- [x] Indexed `(user_id, category, time)`, pricing lookup, and
      `ai_daily_usage(user_id, day)` keys are planned.
- [x] No dynamic provider-price fetch at request time.

## Boundaries & Naming

- [x] AI analytics framed as CloudTime-original personal analytics.
- [x] No third-party product names in routes, schemas, or identifiers.
- [x] `WakaTime-compatible` used only as documentation wording.
- [x] No third-party source code, visual assets, or product copy consulted.

## Research Coverage

- [x] Provider token-class pricing checked against official OpenAI and Anthropic
      docs.
- [x] Prompt-cache write/read distinction reflected in token classes.
- [x] Client-side cost-as-estimate guidance reflected in semantics.
- [x] Clarifications recorded with rationale in `research.md`.
