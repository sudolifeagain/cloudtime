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
- `master` is production — only updated via `develop` merge

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

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
<!-- SPECKIT END -->
