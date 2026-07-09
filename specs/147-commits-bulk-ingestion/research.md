# Research & Decisions: Bulk commit ingestion

**Branch**: `147-commits-bulk-ingestion` | **Date**: 2026-07-09

Documented decisions that shape the contract. Each records the choice, the alternatives, and why. Where the single endpoint (#135) already fixed a convention, this feature follows it rather than re-litigating it.

> **On clarifications**: this is an unattended docs stage. Where a maintainer would normally be asked, the most conservative reasonable choice was made and recorded here (D-2, D-3, D-4, D-5), preferring consistency with the existing `external_durations.bulk` endpoint and the Cloudflare per-request budget.

## D-1: Endpoint shape — a `.bulk` sibling taking a bare array

**Decision**: `POST /users/current/projects/{project}/commits.bulk`, request body a bare JSON array of `CommitInput`, capped at 100. Response `201 { data: Commit[] }`.

**Why**: This is exactly the shape of the two existing bulk endpoints — `heartbeats.bulk` and `external_durations.bulk` — so clients and the router treat it uniformly. `project` stays in the path (consistent with the single endpoint and the read endpoints); the array carries only per-commit bodies. Reusing the `{ data: … }` envelope keeps the response identical in shape to the single-create and read endpoints.

**Alternatives rejected**:
- *Wrapper object* (`{ "commits": [ … ] }`): diverges from both existing bulk endpoints for no benefit.
- *Git-push event object* (`{ "ref": …, "commits": [ … ] }`): couples the contract to a push shape and a git host; the webhook adapter (#146) is a separate, provider-facing concern that can translate into this array.

## D-2: All-or-nothing validation + single `db.batch()`, always 201

**Decision**: Validate **every** element before writing anything; the first invalid element returns `400 item {i}: {message}` and nothing is written. Then persist all elements in one `db.batch()` of the existing `INSERT … ON CONFLICT(user_id, project, hash) DO UPDATE … RETURNING`. Always `201`. An empty array returns `201 { data: [] }`.

**Why**: This is the `external_durations.bulk` convention verbatim (`src/routes/external-durations.ts`), so bulk commit ingestion is internally consistent with the closest existing sibling. All-or-nothing gives the caller a single atomic unit — a push either lands whole or is rejected whole — which is far easier to reconcile than a partial write. A single `db.batch()` is one D1 round-trip and one implicit transaction, satisfying the Cloudflare bulk-write constraint (`docs/cloudflare-constraints.md`: "D1 bulk writes via `db.batch()`, never one row at a time in a loop").

**Alternatives rejected**:
- *Per-item status array* (the `heartbeats.bulk` `202 { responses: [[item, status], …] }` shape): partial success is useful for the lossy high-frequency heartbeat stream, but the issue asks for the stored `Commit[]` and commit ingestion is idempotent import-shaped (like `external_durations.bulk`), where all-or-nothing is the established and simpler contract.
- *Per-element upsert in a loop*: N round trips and forbidden by the Cloudflare constraint; `db.batch()` replaces it.

## D-3: No server-side heartbeat correlation in bulk

**Decision**: Bulk ingestion does **not** derive `total_seconds` from heartbeats. A supplied value (including an explicit `0`) is stored verbatim; an omitted one is stored absent (read path renders `"0 secs"`). Server-side correlation stays a single-endpoint (#135/#145) behavior.

**Why**: The single endpoint derives an omitted `total_seconds` by correlating the user's heartbeats in a bounded window around the commit (#145): per commit that is a previous-commit + window-bounds read plus a heartbeat window read of up to `CORRELATION_HEARTBEAT_LIMIT` (5000) rows, then an O(window) gap sum. Doing that per element in a 100-commit batch would issue on the order of 200 additional D1 subrequests and scan up to hundreds of thousands of heartbeat rows in one request — well past the Workers per-request CPU (~10ms) and subrequest budget that `docs/cloudflare-constraints.md` binds, and it would defeat the whole point of the single `db.batch()`. The conservative, budget-safe contract is: bulk stores what the client sends; a caller that wants derived time either posts that commit through the single endpoint (which correlates) or computes and supplies `total_seconds`. This is also what the issue scope describes (validate each element, then a single `db.batch()` of upserts — no correlation).

**Alternatives rejected**:
- *Per-element correlation (parity with the single endpoint)*: O(N) subrequests + heartbeat scans; breaks the per-request budget (above). Rejected.
- *Shared-window batch correlation* (one heartbeat read over the union window `[min(lower), max(upper)]` across the batch, then attribute per-commit in memory using each commit's own previous-commit boundary, including boundaries formed by sibling commits in the same batch): this **would** keep it to O(1) heartbeat reads and is an attractive future enhancement, but the per-commit boundary interplay (DB neighbours vs same-batch neighbours, ordering, over-cap truncation across a wider window) is a materially harder design than this issue needs. **Deferred**, not dropped — recorded here and in tasks "Out of scope" so it is a conscious follow-up (a natural companion to #146's push adapter), not a silent gap.

## D-4: Batch cap of 100

**Decision**: Cap the array at 100 elements per request. Over-cap → `400`.

**Why**: Matches `external_durations.bulk` (100, sized for bulk import), the closer analogue for commits, rather than the `heartbeats.bulk` cap of 25 (sized for the WakaTime-compatible legacy beat stream). A push or a history import can carry many commits, and — because there is no per-element correlation (D-3) — 100 idempotent upserts fit in a single `db.batch()` (one D1 round-trip; `external_durations.bulk` already ships and is tested at exactly this cap). Each upsert binds 14 parameters, comfortably within D1's per-statement bound-parameter limit.

**Alternatives rejected**: 25 (heartbeat cap) — unnecessarily small for commit imports; unbounded — a batch of thousands risks the D1 statement/response limits and a slow single request.

## D-5: Idempotency within a batch — apply in order, last-wins

**Decision**: If a single batch lists the same `(project, hash)` twice, the upserts apply in array order inside the one `db.batch()` transaction; the last occurrence's values persist. The **response** mirrors input cardinality — one `Commit` entry per input element in request order (the earlier occurrence carrying its pre-overwrite `RETURNING` snapshot, the later the last-wins values), matching `external_durations.bulk`'s map-every-result shape — while a follow-up read returns the single persisted (last-wins) row. The endpoint does not reject or specially de-duplicate in-batch duplicates. Clients are advised to de-duplicate.

**Why**: The upsert is idempotent on `(user_id, project, hash)`; two occurrences in one batch behave exactly like re-posting — the second `ON CONFLICT DO UPDATE` sees the first's row and updates it (last-wins persisted). This is identical to `external_durations.bulk`'s behavior on `(user_id, external_id)`, so bulk commit ingestion needs no special case. Rejecting in-batch duplicates would add a scan and a new 400 path for a caller error that idempotency already makes harmless.

**Alternatives rejected**: reject-on-duplicate (409/400) — hostile and unnecessary given idempotency; collapse duplicates server-side — hidden magic that diverges from the sibling endpoint.

## D-6: Reuse the single endpoint's validator and upsert unchanged

**Decision**: Reuse `validateCommitInput` (`src/utils/commit-input.ts`) per element and the existing `UPSERT_SQL` / `rowToCommit` (`src/routes/commits.ts`) unchanged. No new request or response schema; no schema change; no new validation surface.

**Why**: The single and bulk endpoints share one element contract — same fields, same caps, same date normalization, same `Commit` output. Sharing the validator guarantees the two endpoints can never drift in what a valid commit is, and reusing the upsert keeps one write path. The only refactor in PR2 is extracting the per-element upsert-statement builder (so both the single and bulk paths bind it identically), behavior-preserving.

**Alternatives rejected**: a bulk-specific validator or upsert — duplicates logic and invites drift between the two endpoints.
