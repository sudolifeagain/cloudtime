# Acceptance Checklist: Commits Read Endpoints

## PR1 (Spec) gate — must be ✅ before merging

- [x] `spec.md` covers FR-001..FR-007 (list + single, read-only) with no `[NEEDS CLARIFICATION]` markers.
- [x] `spec.md` records the scope decision (read path first; ingestion deferred).
- [x] `plan.md` Constitution Check has all five principles marked PASS.
- [x] `research.md` documents the 5 design decisions.
- [x] `data-model.md` confirms no D1 schema change and documents the read queries.
- [x] `quickstart.md` enumerates scenarios A–F.
- [x] `tasks.md` separates PR1 from PR2 with dependency arrows.
- [x] `contracts/openapi-diff.md` documents the `400`, descriptions, pagination requirements, and `human_readable_total` requiredness.
- [x] Both commit path files carry the descriptions; the list has a `400`.
- [x] `npm run generate` adds the 400, JSDoc, required list pagination fields, and required `human_readable_total`; `npm run typecheck` passes.
- [x] PR1 contains no runtime code under `src/` (only regenerated `src/types/generated.ts`).
- [x] PR1 references issue #107.

## PR2 (Implementation) gate — must be ✅ before merging

### Code

- [ ] `src/routes/commits.ts` implements both handlers behind `authMiddleware`:
  - `GET /projects/:project/commits` — `COUNT` + paged `SELECT` (100/page, `author_date` DESC), `author`/`branch` filters, `{data, page, total_pages}`, `400` on invalid `page`.
  - `GET /projects/:project/commits/:hash` — single by `(user_id, project, hash)`, optional `branch` exact-matches `ref`, `404` when absent or mismatched.
  - `rowToCommit` adds `human_readable_total = formatHumanReadable(total_seconds ?? 0)` and normalises dates.
- [ ] `src/index.ts` mounts the router at `/api/v1/users/current` (coexists with the users router's `/projects`).
- [ ] No ingestion path; heartbeat ingestion untouched.
- [ ] `npm run typecheck` passes; no hand-edited generated types.

### Behaviour (per `quickstart.md`)

- [ ] A: list newest-first with `human_readable_total`; B: pagination + invalid-page 400; C: author/branch filters.
- [ ] D: single returns commit / 404 unknown or branch mismatch; E: empty project `{data:[], total_pages:0}`; F: 401 + cross-user isolation.

### Tests

- [ ] `tests/integration/commits.test.ts`: seed commits → list ordering/pagination/filters, single + 404 including branch mismatch, empty project, invalid page 400, cross-user, 401.
- [ ] `npm test` stays green with the new coverage.

## Post-deployment gate

- [ ] Seed a commit via `wrangler d1 execute` and confirm it lists / fetches with correct `human_readable_total`.
- [ ] No 500s on the endpoints in the first 7 days.
- [ ] Follow-up issue filed for commit ingestion (plugin vs webhook).
