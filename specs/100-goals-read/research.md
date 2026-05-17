# Research: Goals Read Endpoints

## Decision 1: Read summaries, not heartbeats

**Decision**: `chart_data` is built by summing rows from the `summaries` table, never from `heartbeats`.

**Rationale**:
- `summaries` is already aggregated per user / date / project / language / editor / etc by the hourly cron. Reading it is O(matches), heartbeats would be O(raw events).
- Stays within the 10ms CPU budget on the free tier even for active users.
- Matches what the existing `/summaries`, `/stats`, and `/status_bar/today` endpoints do; consistent behaviour across the API.
- Side benefit: deletes/edits to heartbeats outside the aggregation window don't change goal chart history (which is desirable — goals are about historical effort, not present-time replay).

**Alternative considered**:
- **Live heartbeat scan**: would give second-by-second accuracy for the current period but requires scanning a much larger table. The cron lag (≤1 hour) is acceptable for goals since the unit of comparison is a day or week.

---

## Decision 2: Week boundary = ISO 8601 Monday-Sunday

**Decision**: For `delta=week` goals, a "week" runs from Monday 00:00 to Sunday 23:59 in the user's profile timezone.

**Rationale**:
- ISO 8601 is the international standard. Most developer tools use it.
- Avoids US-centric Sunday-Saturday weeks which surprise non-US users.
- The cron aggregator already buckets summaries by user-timezone day; ISO week is a deterministic function of those days.

**Alternative considered**:
- **US Sunday-Saturday**: rejected on i18n grounds.
- **User-configurable week start**: out of scope; can be added later via a column on `users` or `goals` without breaking the contract.

---

## Decision 3: `is_snoozed` overrides top-level `status` only

**Decision**: When `is_snoozed=true`, the top-level `status` field is forced to `pending`. The `chart_data` array still contains per-period `range_status` values computed normally.

**Rationale**:
- The user is pausing *interpretation*, not data collection. They still want to see what their activity looks like.
- Reflects common goal-tracking behaviour and what most users intuitively expect.
- Keeps the per-period status pure (a function of actuals and target) so callers who want raw data can ignore the top-level field.

**Alternative considered**:
- **Force all `range_status` to `pending` when snoozed**: makes the chart less informative. Rejected.

---

## Decision 4: Per-period status uses `>=` (or `<=` if inverse)

**Decision**: `range_status` is `success` if `actual_seconds >= target_seconds` (`actual_seconds <= target_seconds` when `is_inverse=true`), `fail` otherwise, except the current incomplete period which is always `pending`.

**Rationale**:
- Hitting exactly the target counts as success. Anything else would surprise users who set round numbers.
- Inverse semantics (cap-style goals like "stay under 1h on Twitter") need the opposite comparison; the boolean is sufficient to model both.

**Alternative considered**:
- **Strict `>` for success**: punishes users who hit their target exactly. Rejected.

---

## Decision 5: Top-level `status` mirrors the most recently completed period

**Decision**: The top-level `status` field equals the `range_status` of the chart entry immediately preceding the pending one — i.e., "yesterday's verdict" for day goals, "last week's verdict" for week goals.

**Rationale**:
- Users want a glanceable answer: "Am I doing OK?" — most recent completed period is the right answer for that.
- More sophisticated aggregations (e.g., "3 out of last 5") are subjective and can be UI-side derivations from `chart_data`.

**Alternative considered**:
- **Weighted average / streak count**: domain-modeling debt. Defer to clients.

---

## Decision 6: 7-period window (current + 6 prior)

**Decision**: `chart_data` always returns 7 entries: today plus the six days before (or this-week plus the six weeks before).

**Rationale**:
- Compatible clients generally expect a compact recent-history window; matching that convention reduces client surprises.
- Seven is enough for users to see a recent trend without paging.
- Pre-aggregated; bounded read cost.

**Alternative considered**:
- **Configurable count via query parameter**: adds API surface for marginal benefit. Defer.
- **30-period (month)**: too long for a daily-cadence visualisation; out of scope.

---

## Decision 7: Cross-user requests get 404, not 403

**Decision**: A request for a goal owned by a different user returns 404 Not Found, the same response as a missing ID.

**Rationale**:
- Goal IDs are UUIDs and not meant to be public. Distinguishing "exists but yours not" from "doesn't exist" leaks ID-space information.
- The existing approve endpoint uses the same pattern; we keep behaviour consistent.

**Alternative considered**:
- **403 Forbidden**: clearer for client debugging but a small information leak. Rejected on principle of least information.

---

## Decision 8: List endpoint omits `chart_data`

**Decision**: `GET /goals` returns each Goal *without* `chart_data` or top-level `status`. Single-goal endpoint is the only one that emits chart data.

**Rationale**:
- The list endpoint should be cheap. Computing 7 periods × N goals × possibly 4 dimension filters = unnecessary fan-out for a "show me my goals" call.
- Clients that want chart data for many goals can issue parallel single-goal requests; that pattern stays explicit and rate-limitable per-goal.

**Alternative considered**:
- **Include `chart_data` on list**: simpler client code, but at most users have a few goals so the savings would be marginal compared to the extra D1 reads. Defer until a client actually demands batch chart data.

---

## Decision 9: JSON-decode `languages` / `editors` / `projects` defensively

**Decision**: When decoding the TEXT columns, treat any non-JSON value or non-array result as an empty array, and log a warning. The endpoint MUST NOT 500 because of legacy data.

**Rationale**:
- These columns are user-controlled (will be in the CRUD spec) and may end up with malformed data during migration or external imports.
- Failing fast inside a read endpoint is worse than degraded behaviour; the goal still appears, just without filters applied.

**Alternative considered**:
- **500 on bad JSON**: makes the entire endpoint brittle to one bad row. Rejected.
