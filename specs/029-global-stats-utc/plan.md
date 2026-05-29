# Implementation Plan: Global Stats Always Aggregate in UTC

**Branch**: `029-global-stats-utc` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/029-global-stats-utc/spec.md`

## Summary

Make the unauthenticated `GET /api/v1/stats/{range}` global endpoint ignore any client `timezone`: resolve the range in UTC, key the cache on `global-stats:{range}`, and report `range.timezone = "UTC"`. This removes the cache-fragmentation/bypass vector and the cross-user date ambiguity (#29).

PR1 (this PR): SpecKit artifacts + OpenAPI (drop the `timezone` query param from `getGlobalStats`) + regenerated types. PR2: the small `src/routes/meta.ts` change + a test.

## Technical Context

**Language/Version**: TypeScript (ES2022, Cloudflare Workers)
**Primary Dependencies**: Hono >= 4.9.7
**Storage**: D1 (`summaries`, read) + KV (cache)
**Testing**: Vitest + workers pool — global-stats handler test (timezone ignored, single cache key, range.timezone UTC)
**Performance Goals**: unchanged; in fact fewer recomputations (cache no longer fragmentable)
**Constraints**: none new

## Constitution Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. SDD | PASS | OpenAPI updated first (drop `timezone`); `npm run generate` removes the param from `getGlobalStats`. Handler change lands in PR2. |
| II. Cloudflare-Native | PASS | Pure D1 read + KV cache; no new bindings. |
| III. Type Safety | PASS | Handler uses `components["schemas"]["GlobalStats"]`. No hand-edited types. |
| IV. Legal/Trademark | PASS | No source/asset borrowing. |
| V. Simplicity First | PASS | Removes code (timezone read/validate/cache-key) rather than adding. Rate-limiting deliberately not added. |

## Project Structure

```text
specs/029-global-stats-utc/   # this feature's SpecKit docs
src/routes/meta.ts            # EDIT in PR2: drop timezone handling for global stats
```

**Structure Decision**: The only code change is in the existing `meta.ts` global-stats handler. The authenticated per-user stats handler (`src/routes/stats.ts`) is untouched.

## Phase 0 — Research Outputs

See [research.md](./research.md). Key decisions:
1. **Option 1 (UTC-fix)** over normalize-tz / rate-limit / UTC-column / keep-as-is — it resolves both concerns with the least code.
2. **Drop the `timezone` param from the contract** (honest: it no longer does anything) rather than accept-but-ignore-silently in the spec.
3. **No rate-limiting** needed for the cache concern once the key is un-fragmentable.

## Phase 1 — Design Outputs

### Handler change sketch (PR2, `meta.ts`)

```ts
meta.get("/stats/:range", async (c) => {
  const rangeParam = c.req.param("range");
  const resolved = resolveStatsRange(rangeParam);          // UTC; no tz
  if (!resolved) return c.json({ error: "Invalid range. …" }, 400);

  const cacheKey = `global-stats:${rangeParam}`;            // no tz component
  // … unchanged aggregation …
  range: { start: `${resolved.start}T00:00:00Z`, end: `${resolved.end}T23:59:59Z`, text: resolved.text, timezone: "UTC" },
});
```

The `timezone` query read, the `isValidTimezone` validation, and the tz in the cache key / response are removed. The `isValidTimezone` import is dropped from `meta.ts` if it becomes unused.

### OpenAPI surface

`getGlobalStats` loses its `timezone` query parameter — see [contracts/openapi-diff.md](./contracts/openapi-diff.md). No response-body change.

## Phase 2 — Implementation Tasks

See [tasks.md](./tasks.md).

## Complexity Tracking

Net negative complexity — the change removes branching and a cache-key dimension.
