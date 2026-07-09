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
- [x] Error behavior covers `400`, `401`, and `404`.
- [x] Changes are additive; existing paths/schemas are unchanged.

## Cloudflare Constraints

- [x] Usage range is bounded (<=366 days) for the request CPU budget.
- [x] Bulk ingestion uses `db.batch()` (PR2).
- [x] Indexed `(user_id, category, time)` and pricing lookup keys are planned.
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
