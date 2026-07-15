Think in English, interact with the user in Japanese.

# CloudTime - Development Rules

- All code, comments, commit messages, docs, and PR descriptions must be in English

## SDD (Spec Driven Development)
- `schemas/openapi.yaml` is the Single Source of Truth
- Always update the spec BEFORE writing implementation code
- Commit order: spec change → `npm run generate` → implementation (separate commits)
- Never hand-edit `src/types/generated.ts`
- If a review reveals a spec-level issue, fix it in a separate spec-first PR — never patch the spec inside an implementation PR

## Legal / Trademark Constraints
- "WakaTime" is only allowed as "WakaTime-compatible" in docs — never in code, file names, or branding
- Never use WakaTime's logo, visual assets, or copy their docs/website text
- Never reference or read WakaTime's source code — all implementation must be original
- Write all API docs from our own OpenAPI schema

## Git Branching
- PRs always target `develop` (never `master`)
- Deploy flow differs by audience (see `docs/development-flow.md` → "Branching & PR Strategy"):
  - **Maintainer, active development:** `develop` is both the integration branch and the deploy source. The canonical live instance is deployed directly from a `develop` checkout (`docs/deployment-guide.md`); there is no `develop`→`master` gate on this path. Roll back by Worker version, not by git branch. A Worker rollback does not revert D1, KV, or other resource changes, so deployments and migrations must remain rollback-compatible.
  - **Self-hosters / general users:** `master` is the stable release line to self-host, advanced only by a deliberate `develop`→`master` merge (optionally tagged) when a release is cut — not the maintainer's deploy source.
- `master` intentionally lags `develop` between releases; cutting a stable release is a maintainer decision (a `develop`→`master` merge/tag, currently a clean fast-forward)

## Code
- Framework: Hono >= 4.9.7 on Cloudflare Workers (CVE-2025-58362, CVE-2025-59139)
- DB: Cloudflare D1 (SQLite), Cache: KV
- Use generated types from `src/types/generated.ts` in all route handlers
- License: MIT
- Default: single-user mode (`INSTANCE_MODE=single`). All tables have `user_id` for future multi-user support.

## Cloudflare Constraints
- D1 batch insert (`db.batch()`) for bulk heartbeats — never insert one row at a time in a loop
- Cron aggregation must be incremental (process only new data since `last_aggregated_at`)
- Workers free tier: 10ms CPU per request. Keep handlers fast — offload heavy work to Cron
- See `docs/cloudflare-constraints.md` for full limits and mitigation strategies

## SpecKit 2-PR Workflow
- **PR1 (Spec + Design)**: SpecKit artifacts (`specs/`), OpenAPI spec (`schemas/`), generated types (`src/types/generated.ts`). No implementation code.
- **PR2 (Implementation)**: Route handlers and business logic. Only after PR1 is merged.
- Never mix spec changes and implementation in the same PR

## Testing
- `npm test` runs Vitest inside the Workers runtime via `@cloudflare/vitest-pool-workers`.
- `npm run typecheck` runs `tsc --noEmit` for project + tests.
- Unit-style tests live next to the area they cover under `tests/`:
  - `tests/security/` — pure logic (crypto, rate-limit IP keying, OAuth utilities).
  - `tests/aggregation/` — timezone bucketing, summary/duration builders.
  - `tests/integration/` — endpoint tests with real in-memory D1 (`SELF` / `worker.fetch`).
- The Workers test pool runs `tests/setup.ts` once per file to load `src/db/schema.sql`. Helpers in `tests/helpers/fixtures.ts` mint users + API keys without going through OAuth.
- CI runs both `typecheck` and `test` on every PR (`.github/workflows/test.yml`).

## Current Work Context
- For up-to-date feature context, consult the most recently updated
  `specs/<nnn>-<slug>/plan.md` and the open GitHub issues — they are
  authoritative over the pointer in the managed section below.
- The section between the SPECKIT markers is auto-managed by
  `.specify/extensions/agent-context` (refreshed when a plan is generated);
  it points at the plan that was worked on most recently and may lag behind
  merged work. Do not hand-edit it expecting the edit to persist.

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
at specs/201-ai-attribution-onboarding/plan.md
<!-- SPECKIT END -->
