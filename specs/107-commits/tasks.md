# Tasks: Commits Read Endpoints

**Branch**: `107-commits`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Generated**: 2026-05-29

## PR1 — Spec + Design

- [x] **T-001**: Author `spec.md` (2 read stories, FR-001..FR-007, scope decision, edge cases).
- [x] **T-002**: Author `plan.md` (Constitution Check, route sketch).
- [x] **T-003**: Author `research.md` (5 documented decisions, incl. ingestion deferral).
- [x] **T-004**: Author `data-model.md` (existing table; read queries).
- [x] **T-005**: Author `quickstart.md` (scenarios A–F).
- [x] **T-006**: Author `contracts/openapi-diff.md`.
- [x] **T-007**: Author `checklists/requirements.md`.
- [x] **T-008**: Add descriptions to both commit path files; add `400` to `getProjectCommits`.
- [x] **T-009**: Run `npm run generate` (400 + JSDoc, no body type change); run `npm run typecheck`.
- [ ] **T-010**: Commit PR1 (spec+schema, then types), push, open PR against `develop`.

## PR2 — Implementation (after PR1 merges)

### Route

- [ ] **T-101**: `src/routes/commits.ts` — Hono sub-app, both handlers behind `authMiddleware`:
  - `GET /projects/:project/commits` — parse/validate `page` (400 if invalid), build `WHERE` (`user_id`, `project`, optional `author_email`, `ref`), `COUNT` + paged `SELECT` (100/page, `ORDER BY author_date DESC, hash ASC`), return `{data, page, total_pages}`.
  - `GET /projects/:project/commits/:hash` — single by `(user_id, project, hash)`, `404` when absent.
  - `rowToCommit` (adds `human_readable_total`, normalises dates).
- [ ] **T-102**: Mount in `src/index.ts`: `app.route("/api/v1/users/current", commits)`.

### Tests

- [ ] **T-103**: `tests/integration/commits.test.ts` — list ordering/pagination/filters, single + 404, empty project, invalid page 400, cross-user, 401.

### Verification

- [ ] **T-104**: `npm run typecheck` — zero errors.
- [ ] **T-105**: `npm test` — full suite green incl. new integration.
- [ ] **T-106**: Manual run of `quickstart.md` A / B / D against a staging worker (seed via wrangler).

### PR2 submission

- [ ] **T-107**: Commit with `feat:` prefix, push, open PR against `develop` referencing PR1 and issue #107.

## Follow-up (separate issue)

- [ ] Commit ingestion: decide CLI-plugin `POST` vs git-webhook; add the create path.

## Dependencies

```
T-001 .. T-009 → T-010          (PR1)
T-010 → T-101 → T-102 → T-103 → T-104 → T-105 → T-106 → T-107   (PR2)
```

## Out of scope

- Commit ingestion / `POST` create (follow-up).
- Line-level attribution; commit↔heartbeat linking.
- Cursor pagination; fuzzy author search.
