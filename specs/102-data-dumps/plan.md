# Implementation Plan: Data Dumps (Export)

**Branch**: `102-data-dumps` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/102-data-dumps/spec.md`

## Summary

Wire `getDataDumps` / `createDataDump` to handlers over the existing `data_dumps` table, with an R2-backed async build run by the existing hourly cron. The feature is gated on a bound `R2_BUCKET` (503 when unbound), so it ships safely without R2 provisioned and operators opt in by binding the bucket.

PR1 (this PR): SpecKit artifacts + OpenAPI reconciliation (`type` `daily|full`, `status` + `expired`, `503`/`400` responses, new `ServiceUnavailable` response). PR2: the `R2_BUCKET` binding, the two route handlers, the cron sweep (build + purge), the export bundler, the download mechanism, and tests.

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers)
**Primary Dependencies**: Hono >= 4.9.7
**Storage**: D1 (`data_dumps`, existing) + R2 (`R2_BUCKET`, new binding in PR2)
**Testing**: Vitest + workers pool — handler tests (503 when unbound, create/list, ownership) and bundler unit tests; R2 exercised via the test pool's R2 binding or a stub
**Performance Goals**: <10ms CPU on the request path (the build runs in cron)
**Constraints**: Workers CPU budget; D1 row-size (dumps live in R2, not D1)

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | Operations already declared; PR1 reconciles enums + adds 503/400, PR2 implements. `npm run generate` reflects the enum/response changes. |
| II. Cloudflare-Native | PASS | R2 binding for object storage; reuses the existing hourly cron for async (no Queues). Fail-closed when unbound. |
| III. Type Safety | PASS | Handlers use `components["schemas"]["DataDump"]`. No hand-edited types. |
| IV. Legal/Trademark | PASS | Export shape derived from our own schema/data; "WakaTime-compatible" only in docs. |
| V. Simplicity First | PASS | Cron sweep over Queues; JSON bundle over zip; worker-mediated download over S3 presigning (no extra creds). |

## Project Structure

### Documentation (this feature)

```text
specs/102-data-dumps/
├── plan.md, spec.md, research.md, data-model.md, quickstart.md, tasks.md
├── contracts/openapi-diff.md
└── checklists/requirements.md
```

### Source Code (repository root) — landed in PR2

```text
src/
├── routes/
│   └── data-dumps.ts        # NEW: getDataDumps + createDataDump (R2-gated, 503 when unbound)
├── cron/
│   └── data-dumps.ts        # NEW: processPendingDumps + purgeExpiredDumps (called from scheduled())
├── utils/
│   └── export-bundle.ts     # NEW: buildDailyExport / buildFullExport (pure-ish D1 readers → JSON)
├── types.ts                 # R2_BUCKET?: R2Bucket binding
├── index.ts                 # cron wiring + route mount (+ optional download route)
└── wrangler.toml            # documented [[r2_buckets]] binding (commented opt-in)
```

**Structure Decision**: Thin handlers (gate on binding, write/read one row) keep the request path cheap; all heavy lifting (read D1 → serialise → upload R2) is in the cron module. The bundler is separated so its JSON shape is unit-testable.

## Phase 0 — Research Outputs

See [research.md](./research.md). Key decisions:
1. **R2-gated, 503 when unbound** (email-style fail-closed).
2. **Async = existing hourly cron sweep** (build pending + purge expired); no Queues.
3. **`type` `daily|full`**, **`status` + `expired`** (reconciled).
4. **JSON bundle** (no zip); R2 key `dumps/{user_id}/{dump_id}.json`.
5. **Download** = worker-mediated, token-guarded route (no S3 presign creds); 7-day expiry.
6. **Dedupe**: a `POST` returns an existing `pending`/`processing` dump of the same `type`.

## Phase 1 — Design Outputs

### Handlers (gate first)

```ts
function exportEnabled(env: Env): boolean { return !!env.R2_BUCKET; }

dataDumps.post("/data_dumps", async (c) => {
  if (!exportEnabled(c.env)) return c.json({ error: "Data export not configured" }, 503);
  const { type } = await c.req.json();                 // validate ∈ {daily, full} → 400
  const existing = await findPending(c.env.DB, userId, type);
  if (existing) return c.json({ data: rowToDump(existing) }, 201);
  const id = crypto.randomUUID();
  await insertPending(c.env.DB, id, userId, type);
  return c.json({ data: rowToDump(await selectDump(c.env.DB, id, userId)) }, 201);
});

dataDumps.get("/data_dumps", async (c) => {
  if (!exportEnabled(c.env)) return c.json({ error: "Data export not configured" }, 503);
  // SELECT … WHERE user_id = ? ORDER BY created_at DESC
});
```

### Cron sweep (in scheduled())

```ts
// process a bounded number of pending dumps per run
for (const dump of pending) {
  setStatus(dump.id, "processing");
  const body = dump.type === "full" ? await buildFullExport(env.DB, dump.user_id)
                                     : await buildDailyExport(env.DB, dump.user_id);
  await env.R2_BUCKET.put(`dumps/${dump.user_id}/${dump.id}.json`, JSON.stringify(body));
  setCompleted(dump.id, downloadUrlFor(dump), addDays(now, 7));   // or "failed" on throw
}
// purge: for dumps past expires_at → R2 delete + status="expired"
```

### Download

`download_url` points at a worker-mediated route that validates ownership + a short-lived token and streams the R2 object; expired/unknown → 404. (Presigned R2 S3 URLs are an alternative if S3 creds are configured — see research.) The exact route is finalised in PR2; it is not a new OpenAPI operation in PR1.

### OpenAPI surface

Reconciled in PR1 — see [contracts/openapi-diff.md](./contracts/openapi-diff.md).

## Phase 2 — Implementation Tasks

See [tasks.md](./tasks.md).

## Complexity Tracking

The genuinely new pieces are the R2 binding and the cron build/purge. Both are isolated: handlers gate-and-record only; the bundler is pure D1 reads → JSON; the download path is the one open design point, resolved in PR2 with a worker-mediated default to avoid S3 credentials.
