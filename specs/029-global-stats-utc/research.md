# Research: Global Stats Always Aggregate in UTC

## Decision 1: Option 1 (UTC-fix) over the alternatives

**Decision**: Always aggregate global stats in UTC and drop the `timezone` parameter, rather than normalising timezones to a fixed set, rate-limiting, adding a UTC date column, or keeping the current behaviour.

**Rationale** (the issue listed five options):
- **(1) UTC-fix — chosen.** One small change resolves *both* concerns: the cache key stops varying by timezone (no fragmentation/bypass), and a single UTC boundary removes cross-user date ambiguity. Least code, no new infra, no schema change.
- **(2) Normalise tz to whole-hour offsets** — shrinks but does not eliminate cache-key space, and still leaves cross-user date ambiguity. Half a fix.
- **(3) Per-IP rate-limit** — addresses only the abuse symptom, not the ambiguity, and adds a rate-limit binding + tuning. Unnecessary for the cache concern once the key is un-fragmentable (see Decision 3).
- **(4) UTC date column in `summaries`** — enables true per-tz global aggregation but is a schema migration + aggregator change; over-engineered for an unauthenticated global view. Deferred.
- **(5) Keep as-is** — fine for single-user, but the issue is about hardening before multi-user; we are addressing it now.

**Trade-off accepted**: a client cannot get global stats anchored to their own timezone. For an aggregate-across-all-users view this is acceptable (and arguably more correct) — UTC is a single, well-defined reference. Per-user, timezone-correct stats remain available on the authenticated `GET /users/current/stats/{range}`.

---

## Decision 2: Drop the parameter from the contract (don't silently accept-and-ignore in the spec)

**Decision**: Remove the `timezone` query parameter from the `getGlobalStats` OpenAPI operation. The handler ignores any value still sent.

**Rationale**:
- A declared parameter that no longer affects the response is misleading. Removing it makes the contract honest.
- Removal is non-breaking at runtime: Hono does not 400 on unknown query params, so existing callers passing `?timezone=` keep working (the value is ignored).

**Alternative considered**: keep the param documented as "ignored". Rejected — clutter and confusion; the honest contract is no param.

---

## Decision 3: No rate-limiting needed for this concern

**Decision**: Do not add per-IP rate limiting as part of this fix.

**Rationale**:
- The abuse vector in concern #1 was *cache bypass via timezone fragmentation*. Once the cache key is `global-stats:{range}` (a small, fixed key space — the handful of valid ranges), an attacker cannot force unique cache misses by varying a parameter; repeated requests hit the cache. The 5-minute TTL bounds recomputation regardless.
- Rate-limiting unauthenticated endpoints can still be worthwhile as general defense-in-depth, but it is a separate, optional hardening and out of scope here.

**Alternative considered**: add rate-limiting too. Deferred — not required to close the issue's concerns, and avoids new bindings/tuning.

---

## Decision 4: Authenticated per-user stats unchanged

**Decision**: This change touches only the global `GET /api/v1/stats/{range}` (in `meta.ts`). The authenticated `GET /api/v1/users/current/stats/{range}` keeps using the user's profile timezone.

**Rationale**:
- Per-user stats are scoped to one user whose `summaries.date` is bucketed in their own timezone — a timezone-aware view is correct and unambiguous there. The cross-user ambiguity only arises when aggregating across users.
