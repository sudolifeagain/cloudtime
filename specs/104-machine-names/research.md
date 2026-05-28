# Research: Machine Names Endpoint

## Decision 1: `machine_names` is a side registry, not an FK on `heartbeats`

**Decision**: `heartbeats.machine` keeps storing the raw string. `machine_names` is upserted independently at ingestion; no `machine_id` foreign key is added to `heartbeats`.

**Rationale**:
- The issue (#104) states the heartbeat already stores `machine` as a string and asks only to *also* populate the registry. Adding an FK would be a schema migration and a behavioural change to ingestion for no read-side benefit (no endpoint joins on machine yet).
- This diverges intentionally from `user_agents` (#99), which *does* FK onto heartbeats. User agents are parsed/normalised and reused; machine names are a flat per-device list, so a registry is enough.

**Alternative considered**: foreign-key `heartbeats.machine` → `machine_names.id`. Rejected — migration + ingestion churn, out of scope.

---

## Decision 2: IP from `CF-Connecting-IP`, stored verbatim, owner-private

**Decision**: The upsert sets `ip` to `CF-Connecting-IP` (the real client IP behind Cloudflare), or null when absent. It is returned only in the user-scoped list, never resolved or enriched.

**Rationale**:
- `CF-Connecting-IP` is the canonical client IP on Workers. The `machine_names.ip` column exists to show "last seen from this address."
- The list endpoint is strictly `WHERE user_id = ?`, so a user only ever sees their own machines' IPs — the field is owner-private by construction.

**Alternative considered**: store no IP (drop the column from the response). Rejected — the column exists and the per-device "last IP" is useful to a self-hoster; keeping it user-scoped removes the privacy concern.

---

## Decision 3: Registration follows persistence

**Decision**: A machine is registered only for heartbeats that are actually persisted. Invalid heartbeats (failed validation) and heartbeats dropped by a `hide` custom rule (#101) register no machine.

**Rationale**:
- A hidden heartbeat is meant to leave no trace (#101 FR-009); registering its device would leak that activity occurred. Sequencing the upsert after rule application and validation preserves that guarantee.
- Avoids polluting the registry with devices from rejected payloads.

**Alternative considered**: register on any received `machine` value regardless of persistence. Rejected — contradicts the hide-rule non-disclosure guarantee.

---

## Decision 4: Upsert folded into the heartbeat batch, deduped per distinct machine

**Decision**: The machine upsert is an `INSERT … ON CONFLICT` statement added to the existing heartbeat `db.batch()`. For bulk requests, distinct machine values are collected into a set and upserted once each.

**Rationale**:
- Folding into the existing batch avoids an extra D1 round-trip on the hot path (mirrors `UPSERT_PROJECT_SQL`).
- A 25-item bulk POST from one device should issue one machine upsert, not 25 — dedupe by value (the request IP is constant).
- No `RETURNING` is needed because we do not store an FK; the upsert is fire-and-forget.

**Alternative considered**: a standalone upsert per heartbeat. Rejected — redundant writes and round-trips.

---

## Decision 5: List ordered by `last_seen_at` DESC

**Decision**: `GET /machine_names` returns machines ordered by `last_seen_at` descending, mirroring `GET /user_agents`.

**Rationale**:
- "Most recently active device first" is the natural default for a device list and matches the sibling endpoint, keeping the two registries consistent for clients.

**Alternative considered**: order by `created_at` or `value`. Rejected — recency is the useful axis; consistency with `user_agents` reduces client surprise.
