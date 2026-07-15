# Research: AI Coding Model Attribution Onboarding

Phase 0 decisions. Each resolves a design choice left open by the spec, so no
`[NEEDS CLARIFICATION]` remains for Phase 1.

## D1. Detection source and predicate

- **Decision**: Detect "provider-known, model-unknown" by scanning the existing
  `AIUsageSummary.by_model` groups the dashboard already computes: a group with
  `provider !== "unknown"` **and** `model === "unknown"` **and** `heartbeat_count > 0`
  marks an affected provider/tool. No recomputation, no extra D1 read.
- **Rationale**: The rollup already buckets `ai_model = NULL` as `"unknown"`
  (`src/cron/aggregate.ts`), and `buildUsageSummary` already groups by
  `(provider, model)`. Reusing it keeps the request path free of new queries
  (Principle II) and adds no new data (Principle V).
- **Alternatives considered**: (a) a dedicated D1 aggregate query over raw
  heartbeats — rejected: extra round-trip + duplicates existing logic; (b) parse
  User-Agents at request time — rejected: attribution already happens at ingest.

## D2. Recent window (avoid nagging on frozen history)

- **Decision**: Detection uses the **same trailing window the dashboard AI panel
  already renders** (default ~30 days). Only unattributed usage inside that window
  triggers the guidance.
- **Rationale**: The panel's summary is already windowed; reusing it means the
  step reflects *recent, actionable* state and a fixed pile of old "unknown" rows
  (e.g. pre-setup heartbeats) stops nagging once they age out — satisfying FR-006/
  FR-007/SC-006 with zero extra state. The summary is cron-maintained, so a new
  heartbeat changes the step only after the next hourly aggregation.
- **Alternatives considered**: all-time detection (rejected: nags forever on
  history); a separate shorter window (deferred: adds a knob for marginal
  responsiveness — revisit only if 30 days feels too slow).

## D3. Dismissal — auto-resolve vs persisted

- **Decision**: **Auto-resolution is the only mechanism in the MVP.** The step is
  shown iff the windowed detection is positive; it vanishes when no unattributed
  usage remains. No stored dismissal flag ships in P1/P2.
- **Rationale**: Simplicity First — a derived, stateless view needs no storage,
  no endpoint, and no OpenAPI change, so PR2 stays presentation-only. It also
  can't get "stuck dismissed" while the problem is unfixed.
- **Alternatives considered**: persisted "don't show again" — **deferred as an
  optional follow-up**. It would add a small owner-scoped
  preference (D1) and therefore an endpoint + generated-types change, which the
  SDD flow requires be its own spec-first PR. Not worth it unless an owner asks to
  suppress guidance while knowingly leaving usage unattributed.

## D4. No API contract for the MVP

- **Decision**: The guidance renders **server-side** in the existing dashboard
  HTML. No new endpoint, request, or response shape; `schemas/openapi.yaml` and
  `src/types/generated.ts` are untouched.
- **Rationale**: The dashboard already server-renders the AI summary; the step is
  just additional derived markup. This keeps the whole feature in one
  implementation PR with no contract review surface (Principle I is satisfied
  vacuously — nothing to spec).
- **Alternatives considered**: a JSON `attribution_status` field on `/ai/usage`
  (deferred: only needed if a non-dashboard client wants the signal).

## D5. Guidance content and tool identification

- **Decision**: Map a known affected `provider` to a human tool + its own
  instructions. `openai` → "Codex", with the exact command
  `node scripts/patch-codex-wakatime.mjs` and the canonical public URL for
  `docs/codex-model-attribution.md`. An unmapped provider gets generic wording
  and the canonical public AI-usage troubleshooting URL; it gets no command and
  no Codex-specific link. The step states plainly that the fix runs on the owner's
  machine and the server only instructs (FR-003), and it shows **no** secrets or
  raw config (FR-004).
- **Rationale**: A copy-pasteable command is valuable only when it is known to
  apply. Reusing the Codex patch for another tool could modify an unrelated local
  plugin, so provider-specific commands are opt-in while the generic fallback is
  read-only troubleshooting.
- **Alternatives considered**: embedding the full steps inline only (rejected:
  duplicates the doc, drifts); auto-running anything (impossible — server can't
  touch the client, the core constraint).

## D6. P3 (proactive first-run onboarding) surface

- **Decision**: **Out of the MVP.** The repo has no first-run/setup-wizard surface
  today; P3 needs a new surface (e.g. a setup checklist on a fresh instance) and a
  way to show tool guidance before any heartbeats exist. Capture it as a follow-up
  slice once P1 proves the content.
- **Rationale**: Avoids inventing an onboarding framework for a one-step need;
  keeps MVP shippable (Principle V).
- **Alternatives considered**: force P3 into the dashboard empty-state now
  (deferred: reuse P1's descriptor there later with minimal work).

## Summary of what ships in the MVP (P1+P2)

A pure `detectUnattributedTools(summary)` helper + a server-rendered guidance
block in the AI panel that auto-resolves. No storage, no endpoint, no schema
change, no cron/ingest change. Follow-ups (own PRs): persisted dismissal, `/ai/usage`
`attribution_status`, P3 onboarding.
