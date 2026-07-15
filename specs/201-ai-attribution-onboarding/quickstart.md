# Quickstart / Validation: AI Coding Model Attribution Onboarding

How to prove the MVP (P1/P2) works end-to-end. Validation is via the Workers-pool
integration test on the real `/app` render plus a unit test on the detection
predicate — mirroring `tests/integration/app-ai-pricing.test.ts` and
`tests/aggregation/ai-default-prices.test.ts`.

## Prerequisites

- `npm ci` (Vitest + `@cloudflare/vitest-pool-workers` already configured).
- Fixtures: `tests/helpers/fixtures.ts` (`seedUserWithSession`) to mint an owner +
  session; seed `ai_daily_usage` rows directly (as the pricing test does).

## Run

```sh
npm run typecheck
npm test -- app-ai-attribution        # integration render test
npm test -- ai-attribution            # unit predicate test
npm test                              # full suite (must stay green)
```

## Scenario 1 — guidance shown for recent Codex/unknown usage (P1)

1. Seed an owner (timezone UTC) and a **today** `ai_daily_usage` row with
   `provider='openai'`, `model` **NULL**, `heartbeat_count > 0`.
2. `GET /app` with the session cookie.
3. **Expect**: the response HTML contains the guided attribution step — the cause,
   the exact command `node scripts/patch-codex-wakatime.mjs`, and a link to
   `docs/codex-model-attribution.md`. It contains **no** secret/config value.

## Scenario 2 — hidden when nothing to fix / only Claude Code (P1, FR-005)

1. Seed an owner with only `provider='anthropic'`, `model='claude-opus-4-8'` usage
   (attributed).
2. `GET /app`.
3. **Expect**: the guided step is **absent**.

## Scenario 3 — auto-resolves; historical unknown alone does not nag (P2, FR-006/FR-007)

1. Seed an **out-of-window** `openai`/NULL row (e.g. dated before the trailing
   window) and, in-window, only attributed rows.
2. `GET /app`.
3. **Expect**: the guided step is **absent** (only recent, actionable state drives
   it). Add an in-window `openai`/NULL row and reload → the step reappears; replace
   it with an attributed row → it disappears again.

## Scenario 4 — unit predicate

`detectUnattributedTools(summary)`:

- Summary with a `by_model` group `{provider:'openai', model:'unknown', heartbeat_count:2}`
  → `hasUnattributed = true`, one `affected` entry `{provider:'openai', tool:'Codex', heartbeatCount:2, hasTailoredGuidance:true}`.
- Summary with only `{provider:'anthropic', model:'claude-opus-4-8'}` → `hasUnattributed = false`.
- Summary with `{provider:'unknown', model:'unknown'}` (provider itself unknown) →
  **not** affected (we only guide when the provider/tool is identifiable).
- Multiple `openai`/unknown groups fold to a single `affected` entry with summed count.

## Done / acceptance

- Scenarios 1–4 pass; full suite green; `npm run typecheck` clean.
- Manual (optional): on the live dashboard, an owner with recent Codex/unknown
  usage sees the step; after running the command and a new heartbeat arrives, the
  step clears on the next load.
- No change to estimated cost or token figures for the same underlying usage
  (SC-005) — the pricing tests remain unchanged and green.
