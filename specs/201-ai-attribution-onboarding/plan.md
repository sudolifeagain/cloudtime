# Implementation Plan: AI Coding Model Attribution Onboarding

**Branch**: `spec/201-ai-attribution-onboarding` | **Date**: 2026-07-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/201-ai-attribution-onboarding/spec.md`

## Summary

Surface a guided, self-resolving setup step in the owner dashboard when recent AI
coding usage is attributed to a known provider but an **unknown model** (today:
Codex → `openai`/unknown). The Codex step explains the cause, gives the exact
one-time client-side command the owner runs on their own machine, and links to the
full instructions; unmapped providers receive generic troubleshooting without a
command. The step disappears once no unknown usage remains in the cron-maintained
trailing summary.

Technical approach: **presentation-only** for the P1/P2 MVP. Detection is a pure,
derived read over the AI usage summary the dashboard **already computes**
(`buildUsageSummary` → `by_model`), so there is **no new query in the request
path, no new stored data, and no API/OpenAPI change**. The guidance renders
server-side in the existing AI panel. Persisted "dismiss forever" and the proactive
first-run onboarding (P3) are isolated as optional follow-ups because they would
introduce stored state / a new surface.

## Technical Context

**Language/Version**: TypeScript (strict), targeting the Cloudflare Workers runtime.

**Primary Dependencies**: Hono (server-rendered JSX dashboard). No new runtime dependency.

**Storage**: Cloudflare D1 — **read-only reuse** of the hourly cron-maintained `ai_daily_usage` rollup via the existing summary builder. **No new tables/columns for the MVP.** (A future persisted dismissal would add one small owner-scoped row — out of MVP scope.)

**Testing**: Vitest in the Workers pool (`@cloudflare/vitest-pool-workers`) — one unit test for the detection predicate, one integration test on the `/app` render (mirror `tests/integration/app-ai-pricing.test.ts`).

**Target Platform**: Cloudflare Workers (single canonical instance; single-user mode).

**Project Type**: Web service with a server-rendered owner dashboard.

**Performance Goals**: Stay within the Workers free-tier ~10 ms CPU budget. The dashboard already loads the AI usage summary; detection is an O(number of `by_model` groups) scan over that in-memory result — **zero additional D1 round-trips**.

**Constraints**: Presentation/onboarding only — MUST NOT change pricing, aggregation, or ingestion. No secrets or raw client config in the guidance. A provider-specific command/link is shown only for the provider it applies to; generic fallback guidance is read-only troubleshooting. Owner-facing copy original and trademark-compliant ("WakaTime-compatible").

**Scale/Scope**: One owner; a handful of `by_model` groups per window. Trivial scale.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment | Verdict |
|-----------|------------|---------|
| **I. SDD (spec is SSoT)** | MVP adds **no** endpoint/field, so `schemas/openapi.yaml` and `src/types/generated.ts` are **unchanged** — nothing to spec-first. Detection reuses the existing `AIUsageSummary`. If persisted dismissal (optional) is later built, it gets its own spec-first PR (new endpoint/field). | ✅ Pass |
| **II. Cloudflare-Native** | No new D1 query in the request path (derives from the already-loaded summary); no KV writes; no cron change. Within CPU budget. | ✅ Pass |
| **III. Type Safety & Codegen** | Uses existing generated `AIUsageSummary`/`AITokenTotals` types; no hand-written aliases; no generated-file edits. | ✅ Pass |
| **IV. Legal & Trademark** | All new copy is original; user-facing wording uses "WakaTime-compatible"; links to our own `docs/codex-model-attribution.md`. No WakaTime assets/text/source. | ✅ Pass |
| **V. Simplicity First** | No new abstraction, storage, endpoint, or flag for the MVP. Auto-resolution replaces stateful dismissal. Detection is a small pure predicate, and generic guidance never needs a provider-specific command. | ✅ Pass |

**Result**: All gates pass. No entries in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/201-ai-attribution-onboarding/
├── plan.md              # This file
├── research.md          # Phase 0 — design decisions
├── data-model.md        # Phase 1 — derived shapes; "no new persistent entities" (MVP)
├── quickstart.md        # Phase 1 — how to validate end-to-end
├── contracts/
│   └── README.md        # Phase 1 — "no new API contract for the MVP" (rationale)
├── checklists/
│   └── requirements.md  # /speckit-specify quality checklist
└── tasks.md             # /speckit-tasks output (NOT created here)
```

### Source Code (repository root)

```text
src/
├── utils/ai/
│   ├── usage.ts            # existing AIUsageSummary builder (by_model, missing_price_count) — source of truth for detection
│   └── attribution.ts      # NEW (small): pure detectUnattributedTools(summary) predicate + guidance descriptor
├── ui/
│   └── dashboard.tsx       # MODIFY: render the guided step in the AI panel (near the existing missing_price_count Notice)
└── routes/
    └── app.tsx             # (no change expected) already loads the AI usage summary for the dashboard

tests/
├── aggregation/
│   └── ai-attribution.test.ts     # NEW unit: detection predicate over crafted summaries
└── integration/
    └── app-ai-attribution.test.ts # NEW integration: /app render shows/hides the guidance (mirrors app-ai-pricing.test.ts)
```

**Structure Decision**: Single project (existing repo layout). The MVP is a small
pure helper (`src/utils/ai/attribution.ts`) plus a render block in the existing
server-rendered dashboard (`src/ui/dashboard.tsx`). No new route, module, or
storage layer. P3 (first-run onboarding) and persisted dismissal would add surface
area and are deliberately excluded from this structure.

## Complexity Tracking

> No Constitution violations — no justifications required.
