# Implementation Plan: Commits Read Endpoints

**Branch**: `107-commits` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/107-commits/spec.md`

## Summary

Wire the two declared read operations (`getProjectCommits`, `getProjectCommit`) to handlers over the existing `commits` table. List is paginated (100/page, `author_date` DESC) with `author`/`branch` filters; single is by `(user_id, project, hash)` plus optional `branch`/`ref` filtering → 404 when absent or mismatched. Ingestion is deferred (read path first, mirroring Goals #95/#96).

PR1 (this PR): SpecKit artifacts + OpenAPI descriptions + a `400` on the list (invalid page). PR2: the route + tests.

No D1 migration, no new binding.

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers)
**Primary Dependencies**: Hono >= 4.9.7
**Storage**: D1 (`commits`, existing)
**Testing**: Vitest + workers pool — integration tests over seeded `commits`
**Performance Goals**: <10ms CPU — one `COUNT` + one page `SELECT` for list; one `SELECT` for single
**Constraints**: page size 100; `(user_id, project, hash)` scoping

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | Operations already declared; PR1 adds descriptions + a `400`, PR2 implements. `npm run generate` adds the 400 response + JSDoc. |
| II. Cloudflare-Native | PASS | Indexed D1 reads + the shared duration formatter. No new bindings. |
| III. Type Safety | PASS | Handler uses `components["schemas"]["Commit"]`. No hand-edited types. |
| IV. Legal/Trademark | PASS | Read contract from our own schema; no upstream source/assets. |
| V. Simplicity First | PASS | One router, two handlers, read-only. Ingestion deferred to avoid an unresolved plugin-vs-webhook decision. |

## Project Structure

### Documentation (this feature)

```text
specs/107-commits/
├── plan.md, spec.md, research.md, data-model.md, quickstart.md, tasks.md
├── contracts/openapi-diff.md
└── checklists/requirements.md
```

### Source Code (repository root) — landed in PR2

```text
src/
├── routes/
│   └── commits.ts          # NEW: getProjectCommits + getProjectCommit handlers
└── index.ts                # NEW route mount
```

**Structure Decision**: A new `commits.ts` router mounted at `/users/current`, defining `/projects/:project/commits` and `/projects/:project/commits/:hash`. These paths are more specific than the users router's `/projects`, so they coexist. `human_readable_total` reuses `formatHumanReadable` from `time-format.ts`.

## Phase 0 — Research Outputs

See [research.md](./research.md). Key decisions:
1. **Read path first; ingestion deferred** (plugin-vs-webhook is an open product decision).
2. **Pagination**: 100/page, `author_date` DESC, `page` 1-based, invalid page → 400.
3. **Filters**: `author` → `author_email` exact; `branch` → `ref` exact.
4. **Single → 404** for unknown/cross-user/branch mismatch (no existence leak).
5. **`human_readable_total`** derived from `total_seconds` (0 when NULL).

## Phase 1 — Design Outputs

### Route sketch

```ts
const PAGE_SIZE = 100;

commits.get("/projects/:project/commits", async (c) => {
  const project = c.req.param("project");
  const page = parsePage(c.req.query("page"));      // 400 if invalid
  if (page === null) return c.json({ error: "Invalid page" }, 400);
  const conditions = ["user_id = ?", "project = ?"]; const binds = [userId, project];
  if (author) { conditions.push("author_email = ?"); binds.push(author); }
  if (branch) { conditions.push("ref = ?"); binds.push(branch); }
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM commits WHERE …`).bind(…).first()).n;
  const rows = await db.prepare(
    `SELECT … FROM commits WHERE … ORDER BY author_date DESC, hash ASC LIMIT ? OFFSET ?`,
  ).bind(…, PAGE_SIZE, (page-1)*PAGE_SIZE).all();
  return c.json({ data: rows.map(rowToCommit), page, total_pages: Math.ceil(total / PAGE_SIZE) });
});

commits.get("/projects/:project/commits/:hash", async (c) => {
  const conditions = ["user_id = ?", "project = ?", "hash = ?"];
  const binds = [userId, project, hash];
  if (branch) { conditions.push("ref = ?"); binds.push(branch); }
  const row = await db.prepare(`SELECT … FROM commits WHERE ${conditions.join(" AND ")}`).bind(...binds).first();
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ data: rowToCommit(row) });
});
```

`rowToCommit` maps the row to the `Commit` schema, adding `human_readable_total = formatHumanReadable(total_seconds ?? 0)` and normalising date-time fields.

### OpenAPI surface

Already declared; PR1 adds descriptions + a `400` on the list — see [contracts/openapi-diff.md](./contracts/openapi-diff.md).

## Phase 2 — Implementation Tasks

See [tasks.md](./tasks.md).

## Complexity Tracking

Bounded: two read handlers over an indexed table, mirroring existing list/single read endpoints (goals, user_agents). The only nuance is pagination math.
