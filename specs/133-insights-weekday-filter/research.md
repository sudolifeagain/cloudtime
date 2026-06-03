# Research & Decisions: `weekday` filter for the `days` insight

**Branch**: `133-insights-weekday-filter` | **Date**: 2026-06-04

Documented decisions that shape the contract. Each records the choice, the alternatives, and why.

## D-1: Weekday numbering convention (0=Sunday … 6=Saturday)

**Decision**: `weekday=0` is Sunday, `1` Monday … `6` Saturday.

**Why**: The existing `weekday` insight already maps weekdays this way — `src/utils/insights.ts` derives the day via `new Date(\`${date}T00:00:00Z\`).getUTCDay()` (0=Sunday) and indexes `WEEKDAY_NAMES = ["Sunday", …, "Saturday"]`. Reusing the same convention keeps the two insight types internally consistent: filtering `days` by `weekday=1` selects exactly the dates the `weekday` insight labels "Monday". Inventing a different (e.g. ISO 0=Monday) convention for the filter would make the two disagree.

**Alternatives rejected**: ISO-8601 (1=Monday…7=Sunday) — clean externally but inconsistent with our shipped `weekday` insight, and we do not read WakaTime source to mirror their exact integer mapping (trademark hygiene). Internal consistency is the deciding factor.

## D-2: Accept both integer and full weekday name

**Decision**: Accept integer `0`–`6` **or** a case-insensitive full English name (`sunday`…`saturday`). They are equivalent.

**Why**: The pre-existing parameter description already hinted "(0-6 or monday-sunday)", so both forms were anticipated. Names are self-documenting for humans; integers are convenient for programmatic clients.

**Alternatives rejected**: Abbreviations (`mon`, `tue`) — adds ambiguity (e.g. locale variants) for little benefit; excluded to keep the accepted set small and unambiguous. Can be added later additively if a client needs it.

## D-3: Validation scope — only when the value is used

**Decision**: Validate `weekday` (→ 400 on bad input) **only** for `insight_type=days`. For all other insight types the value is ignored entirely, including invalid values (200).

**Why**: Forward-compatibility. Clients may already attach `weekday` to every insights request (it was inert before this change). Rejecting it on, say, a `languages` request would be a regression. The principle: validate a parameter where it has meaning; ignore it where it has none.

**Alternatives rejected**: Global validation regardless of type — cleaner-looking but breaks existing clients that blanket-attach the param. Silently ignoring a *malformed* value on `days` — hides client bugs; we 400 instead so authors get feedback.

## D-4: Timezone basis reuses the existing helper

**Decision**: Compute each date's weekday with the same `weekdayOf(date)` logic the `weekday` insight uses — `getUTCDay()` over the `YYYY-MM-DD` string (which is already the user-profile-timezone calendar date produced by aggregation).

**Why**: `summaries.date` is already bucketed in the user's timezone by the hourly cron. The local calendar date *is* the correct unit; interpreting it at UTC midnight and taking `getUTCDay()` yields its weekday without any further conversion. This is exactly what the `weekday` insight already does, so no new timezone code is introduced and the two stay aligned (FR-008).

## D-5: Filter location — pure builder, not SQL

**Decision**: Apply the filter in-memory inside the pure `buildInsight` path (PR2), not via a SQL `WHERE`.

**Why**: SQLite/D1 has no portable timezone-aware day-of-week extraction over our stored local-date strings, and the per-date totals are already materialised in memory after the single `GROUP BY`. Filtering an O(active-days) array is trivial and keeps the one-SELECT, <10ms-CPU shape from #103 (Cloudflare-Native principle). It also keeps the builder unit-testable without D1.

**Alternatives rejected**: `WHERE strftime('%w', date) = ?` — couples to SQLite date functions, risks edge mismatches with our TZ-bucketed strings, and offers no measurable benefit at our data volume.

## D-6: Type surface stays `string`

**Decision**: Keep the OpenAPI `weekday` parameter as `type: string` (with a precise description); do not model it as an enum.

**Why**: The accepted set mixes integers and case-insensitive names, which a single clean JSON-Schema enum cannot express (case-insensitivity, int|string union). A `string` with a descriptive contract plus route-level validation is the pragmatic fit. Consequence: `npm run generate` produces only a JSDoc/description diff for this parameter, not a TypeScript type change — acceptable and expected for this PR1.

## D-7: Scope limited to `weekday`

**Decision**: `timeout` and `writes_only` remain accepted-but-unapplied; this feature only activates `weekday`.

**Why**: Those two cannot be honoured from `summaries` (which already bakes in the session timeout and drops per-heartbeat write flags). Activating them would require a different data path and belongs to separate issues, not this one. Keeping scope to `weekday` matches the "one feature per PR" principle.
