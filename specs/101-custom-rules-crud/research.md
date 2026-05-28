# Research: Custom Rules CRUD + Heartbeat Remap

## Decision 1: `action` = `change | hide` (reconciled from `change | delete`)

**Decision**: The action enum is `change` and `hide`. `hide` drops the heartbeat from persistence.

**Rationale**:
- The issue (#101) describes the two semantics as "remap" and "drop the heartbeat" and names the latter `hide`.
- `delete` was ambiguous in the pre-existing schema — it reads as "delete the rule" rather than "discard the heartbeat." `hide` is unambiguous and matches the intent.
- This is a spec-first PR, the correct place to reconcile a schema-level wording issue per the repo's SDD rules.

**Alternative considered**: keep `delete`. Rejected for ambiguity.

---

## Decision 2: `operation` set + regex deferral

**Decision**: `operation` ∈ `equals | contains | starts_with | ends_with` (underscored tokens). `regex` is **not** included in this version.

**Rationale**:
- The pre-existing tokens used embedded spaces (`starts with`) which are awkward as API enum values and JSON keys; underscores are conventional.
- The issue flags regex as a CPU risk on Workers (10ms budget) and explicitly allows restricting to non-regex operators in the first cut. Unbounded user regex against every heartbeat field is a ReDoS / budget hazard that would need engine time-boxing we are not adding now.
- Adding `regex` later is a purely additive enum change — no break for existing clients.

**Alternative considered**: include `regex` with a length/timeout guard. Deferred — the guard is its own design problem and not needed for the rename/hide use cases that motivate the issue.

---

## Decision 3: PUT is full-replace, validated before write

**Decision**: `PUT /custom_rules` replaces the entire rule set. The server validates the whole array first; only if every element is valid does it run an atomic `db.batch([DELETE all for user, INSERT each])`. `[]` clears the set.

**Rationale**:
- The declared operation is `updateCustomRules` ("Replace user's custom rules") — replace, not merge. Full-replace is the simplest model for a client that edits a list and saves it.
- Validate-then-write guarantees FR-003's "existing set unchanged on 400" — we never half-apply.
- `db.batch()` is the Cloudflare-native way to make the delete+insert atomic, and matches the project rule to batch bulk writes.

**Alternative considered**: per-rule POST/PATCH with merge semantics. Rejected — not the declared contract, and more endpoints/state for no added value here.

---

## Decision 4: Cross-user / unknown DELETE → 404

**Decision**: `DELETE /custom_rules/{rule_id}` for a rule the caller does not own, or an unknown id, returns 404. The `WHERE id = ? AND user_id = ?` clause makes "not yours" and "not found" indistinguishable.

**Rationale**: Consistent with the Goals and read endpoints (no id-existence leak). One scoped statement, no fetch-then-check TOCTOU.

**Alternative considered**: 403 for owned-by-other. Rejected — leaks existence.

---

## Decision 5: KV-cached rule set, invalidated on mutation

**Decision**: The compiled rule set is cached in KV under `customrules:${user_id}` (JSON array, pre-sorted). Ingestion reads the cache; a miss falls back to a D1 `SELECT` and repopulates. `PUT` and `DELETE` delete the cache key.

**Rationale**:
- Heartbeat ingestion is the hot path and is CPU-budgeted. A D1 read per heartbeat request to fetch rules would be wasteful when rules change rarely.
- Rules are single-digit per user, so the cached payload is tiny.
- Explicit invalidation on every mutation keeps the cache correct without TTL guesswork; a short TTL can be layered on later as a safety net.

**Alternative considered**: read rules from D1 on every ingestion. Simpler but adds a D1 round-trip to the hottest path. Rejected on performance.

---

## Decision 6: Sequential application; first `hide` short-circuits

**Decision**: Rules are applied in ascending `priority` (ties by `created_at`). Each `change` mutates the in-memory heartbeat so later rules see the new value. The first matching `hide` ends processing and drops the heartbeat.

**Rationale**:
- A deterministic, documented order is essential — users compose rules (rename A→B, then a rule on B). Sequential-by-priority is the least surprising model.
- Short-circuiting on `hide` is both correct (a dropped heartbeat needs no further rewrites) and cheaper.
- No fixpoint re-evaluation: bounded, predictable cost.

**Alternative considered**: independent rule evaluation against the original values. Rejected — breaks rule composition and is surprising.

---

## Decision 7: `hide` success-response shape verified against the WakaTime-compatible contract

**Decision**: When a `hide` rule drops a heartbeat, the endpoint still returns a per-item *success* result (so callers cannot enumerate what was dropped). The **exact** shape (status code per item, `data` null vs echoed) will be finalised in PR2 by checking the documented WakaTime-compatible bulk-heartbeat response and compatible CLI expectations — **not** by reading upstream source.

**Rationale**:
- The bulk heartbeat response is wire-protocol consumed by editor plugins; diverging risks plugin errors. Project rule: verify wire-protocol behaviour against the CLI/API docs first.
- Not disclosing which items were dropped avoids leaking rule internals to a caller.

**Alternative considered**: return an explicit "hidden" marker per item. Rejected — leaks rule behaviour and risks confusing plugins that expect a stored-heartbeat shape.

---

## Decision 8: Validation cap and NOT NULL handling for `hide`

**Decision**: Cap the rule set at 50 per user (PUT returns 400 above the cap). `hide` rules store empty strings in the NOT NULL `destination` / `destination_value` columns.

**Rationale**:
- The cap bounds both the PUT payload and the per-heartbeat matching loop, protecting the CPU budget; 50 is far above realistic usage.
- `destination` / `destination_value` are NOT NULL in `custom_rules`; since `hide` ignores them, storing `""` satisfies the constraint without a migration and the API never surfaces them as meaningful for `hide`.

**Alternative considered**: make the columns nullable via migration. Rejected — unnecessary schema churn; empty string is sufficient and the API marks them optional/ignored for `hide`.
