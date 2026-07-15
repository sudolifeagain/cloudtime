# Data Model: AI Coding Model Attribution Onboarding

## Persistent entities

**None for the MVP (P1/P2).** The feature adds no D1 table or column and no KV
key. It is a derived view over data already stored and already loaded for the
dashboard. This is a deliberate scope decision (see research.md D3/D4).

## Derived shapes (in-memory, request-time)

These are computed from the existing `AIUsageSummary` (built by
`src/utils/ai/usage.ts`); they are **not** persisted and **not** part of any API
response in the MVP.

### AttributionStatus (derived)

Computed by the new pure helper `detectUnattributedTools(summary)`.

| Field | Type | Meaning |
|-------|------|---------|
| `hasUnattributed` | boolean | True iff ≥1 affected group exists in the window. |
| `affected` | `UnattributedTool[]` | One entry per affected provider (usually 0 or 1). |

### UnattributedTool (derived)

| Field | Type | Source | Meaning |
|-------|------|--------|---------|
| `provider` | string | `by_model[i].provider` | The known provider (e.g. `"openai"`). |
| `tool` | string | mapped from `provider` | Human tool name for copy (e.g. `"Codex"`); generic fallback when unmapped. |
| `heartbeatCount` | number | sum of matching `by_model[i].heartbeat_count` | How many recent heartbeats are unattributed (for the message). |
| `hasTailoredGuidance` | boolean | mapped from `provider` | Whether tool-specific steps exist (else generic + doc link). |

**Selection rule**: a `by_model` group is affected when
`provider !== "unknown" && model === "unknown" && heartbeat_count > 0`.
Groups are folded by `provider` so the guidance shows one entry per tool.

### GuidanceContent (static, code-defined)

A small code-side lookup keyed by `provider`, holding original, trademark-compliant
copy: a one-line cause, the exact local command, and the link to
`docs/codex-model-attribution.md`. Not data — lives in source (see plan.md
`src/utils/ai/attribution.ts`). No secrets, no client config.

## Deferred entity (NOT in MVP — future spec-first PR)

### GuidanceDismissal (only if persisted dismissal is built)

Owner-scoped flag to suppress the guidance while usage is knowingly left
unattributed. Would require a D1 row **and** an OpenAPI/generated-types change, so
per Principle I it is a separate spec-first change. Fields would be roughly:
`user_id`, `provider` (or a global flag), `dismissed_at`. Explicitly out of scope
here; auto-resolution (research.md D3) removes the need for the common case.

## Invariants

- No write path is introduced; the feature never mutates D1 or KV in the MVP.
- Pricing/aggregation/ingestion data and logic are untouched (FR-011): the derived
  status only *reads* `by_model`/`missing_price_count` that already exist.
