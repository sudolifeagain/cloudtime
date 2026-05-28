# Research: External Durations

## Decision 1: Upsert on `(user_id, external_id)`

**Decision**: `createExternalDuration` and `createExternalDurationsBulk` use `INSERT … ON CONFLICT (user_id, external_id) DO UPDATE`. Re-sending the same `external_id` updates the existing row.

**Rationale**:
- External durations come from external sources (calendar, meetings) that are **synced repeatedly**. The natural key is the source's `external_id`. Idempotent upsert lets a client replay a sync without creating duplicates or having to diff first.
- The table already declares `UNIQUE(user_id, external_id)`, signalling this exact intent.

**Alternative considered**: reject duplicates with 409. Rejected — forces clients to track which events they have already pushed; worse ergonomics for a sync source.

---

## Decision 2: Parallel series — not aggregated into `summaries`

**Decision**: External durations are exposed only through `GET /external_durations`. They are **not** folded into `summaries`; the cron aggregator is untouched.

**Rationale**:
- `summaries` back `/stats`, `/summaries`, goals, and insights — all of which mean **coding** time. Merging non-coding calendar/meeting time into them would silently inflate coding metrics and break every existing surface's meaning.
- Keeping a parallel series is the smaller, safer change and matches the issue's "keep them as a parallel series" option. A future product decision could add an opt-in merge.

**Alternative considered**: aggregate into `summaries` with a category flag. Rejected for the first cut — large blast radius on existing read paths and ambiguous product semantics.

---

## Decision 3: Bulk cap 100, all-or-nothing validation

**Decision**: The bulk create cap is 100 (the declared `maxItems`), and validation is all-or-nothing: validate every element, and if any fails return 400 with nothing written.

**Rationale**:
- **Cap**: the OpenAPI schema (`maxItems: 100`) is the single source of truth per the SDD rule, so it wins over the issue prose's "max 25". 100 also suits calendar imports, which are bulkier than heartbeat flushes.
- **All-or-nothing**: the declared bulk response is a flat `{data: ExternalDuration[]}` with no per-item error channel (unlike `heartbeats.bulk`'s `{responses}`), so partial success cannot be expressed. Validate-then-batch keeps the contract honest and avoids half-applied syncs.

**Alternative considered**: per-item `{responses}` like heartbeats. Rejected — the declared response shape is a flat array; changing it would be a larger contract change than warranted.

---

## Decision 4: GET is day-scoped by `start_time`

**Decision**: `GET /external_durations?date=...` returns durations whose `start_time` falls within the local day (in the `timezone` query param if given, else the user's profile timezone), ordered ascending, with optional `project` / `branches` filters. Invalid IANA timezone values return 400.

**Rationale**:
- Mirrors `GET /heartbeats?date=` (same `getEpochBoundsForDate` helper, same timezone convention) so the two day-views behave identically.
- Existing timezone-aware read endpoints validate the timezone query before computing local-day bounds; external durations should follow that pattern instead of letting `Intl.DateTimeFormat` throw.
- Filtering on `start_time` (rather than overlap) is the simplest, most predictable rule and uses the existing `idx_ext_durations_user_time` index.

**Alternative considered**: overlap filtering (durations spanning the day boundary). Rejected for the first cut — adds complexity for a rare case; `start_time` bucketing matches how heartbeats are listed.

---

## Decision 5: Delete by id within day, unknown ids ignored

**Decision**: `DELETE .bulk` with `{date, ids}` deletes the user's durations whose `id ∈ ids` and whose `start_time` is on `date`. Unknown / unowned ids are silently ignored.

**Rationale**:
- Mirrors `DELETE /heartbeats.bulk` (id + date + `user_id` scoping). Ignoring unknown ids makes deletion idempotent and avoids leaking which ids exist.
- The `date` guard keeps deletion symmetric with the day-scoped GET.

**Alternative considered**: 404 when any id is missing. Rejected — leaks existence and breaks idempotent re-deletes.
