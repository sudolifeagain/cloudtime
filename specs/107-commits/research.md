# Research: Commits Read Endpoints

## Decision 1: Ship the read path first; defer ingestion

**Decision**: Implement only the two declared read operations (`getProjectCommits`, `getProjectCommit`). Do not add a `POST` create or any ingestion path in this feature.

**Rationale**:
- The declared OpenAPI surface is read-only, and per the SDD rule the schema is the single source of truth.
- The issue explicitly leaves the ingestion mechanism open — a WakaTime-compatible CLI/editor plugin vs a server-side git webhook. Each carries different auth, source-of-truth, and operator-effort trade-offs; rushing it inside a low-priority read feature would lock in a contract prematurely.
- Mirrors Goals (#95/#96): the read path established the contract and handlers, then mutation followed. The `commits` table can be seeded out of band (`wrangler d1 execute`) meanwhile, and a future ingestion PR makes it live.

**Alternative considered**: add a `POST .../commits` create now (client-plugin ingestion). Rejected for the first cut — it presupposes the plugin-vs-webhook decision and expands a low-priority feature; recommended as the likely follow-up (a client-plugin `POST` best matches the compatible ecosystem).

---

## Decision 2: Pagination — 100/page, `author_date` DESC, 1-based, invalid → 400

**Decision**: The list returns 100 commits per page ordered by `author_date` descending (ties by `hash`). `page` is 1-based and defaults to 1; a non-integer or `< 1` page returns 400; a page beyond the end returns an empty `data`.

**Rationale**:
- Newest-first is the natural commit-log order. A fixed 100/page keeps each response bounded and the query cheap (one `COUNT` + one `LIMIT/OFFSET` read).
- Rejecting a malformed `page` (rather than silently clamping) surfaces client bugs; an out-of-range-but-valid page returning empty is standard and avoids an error for benign over-paging.

**Alternative considered**: cursor pagination. Rejected — offset/page matches the declared `page`/`total_pages` response shape and is sufficient at this scale.

---

## Decision 3: Filters — `author` → `author_email`, `branch` → `ref`

**Decision**: The optional `author` query filters on `author_email` (exact); `branch` filters on the commit `ref` column (exact).

**Rationale**:
- `author_email` is the stable identity in git metadata (names vary); exact match is predictable and indexable-friendly.
- The table's `ref` column is where a branch/ref is stored, so `branch` maps to it directly.

**Alternative considered**: fuzzy/`LIKE` matching or matching `author_name`. Rejected for the first cut — exact match is unambiguous; fuzzy search can be added later without breaking the contract.

---

## Decision 4: Single commit → 404 for unknown / cross-user

**Decision**: `getProjectCommit` looks up `(user_id, project, hash)` and returns 404 when there is no match — whether the hash is unknown or owned by another user.

**Rationale**:
- Consistent with every other single-resource read in the project (goals, etc.): `user_id`-scoped `WHERE`, 404 over 403, no existence leak.

**Alternative considered**: 403 for owned-by-other. Rejected — leaks existence.

---

## Decision 5: `human_readable_total` derived, NULL `total_seconds` → 0

**Decision**: `human_readable_total` is computed from `total_seconds` using the shared `formatHumanReadable` helper; a NULL `total_seconds` is treated as 0.

**Rationale**:
- A commit may be recorded without time attribution (`total_seconds` is nullable). Treating NULL as 0 keeps the response well-formed (`human_readable_total` always a string) rather than leaking nulls or erroring.
- Reusing the existing formatter keeps `human_readable_total` consistent with `/stats` and insights.

**Alternative considered**: omit `human_readable_total` when `total_seconds` is NULL. Rejected — an always-present human string is friendlier for clients and matches the schema's intent.
