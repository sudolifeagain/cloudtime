# Research & Decisions: Server-side commit coding-time correlation

**Branch**: `145-commit-duration-correlation` | **Date**: 2026-07-10

Documented decisions that shape the contract and the PR2 implementation. Each records the choice, the alternatives, and why. This issue implements what #135 research D-3 deferred; that decision (client-supplied only) is **superseded for the omitted case** — a client value still wins (D-2 below).

Where a maintainer would normally be asked, the most conservative reasonable option was chosen and recorded here (this is an unattended spec pass).

## D-1: Where correlation runs — synchronously at ingest, not a cron/backfill pass

**Decision**: Correlate inside the existing `POST .../commits` handler, only when `total_seconds` is omitted. No new cron job, watermark, or backfill table.

**Why**: A `post-commit` hook fires immediately after the commit, so the coding session's heartbeats are already in D1 and recent (they were sent while coding). Ingest-time correlation gives the client an immediate `total_seconds` in the `201` response, keeps the write path stateless, and sidesteps heartbeat retention entirely (a fresh commit's heartbeats are never purged yet). Idempotency does the rest: a commit posted before its heartbeats flushed can be re-posted to re-derive.

**Alternatives rejected**:
- *Cron/backfill pass*: delayed UX (the commit shows `"0 secs"` until the next run), plus new state (which commits are pending, a watermark) — more machinery for a worse result.
- *Async queue / Durable Object*: over-engineered for a single-row derivation that already fits the request budget (D-6); adds a binding and failure modes.

## D-2: Precedence — a client-supplied value wins; correlation only fills an omitted `total_seconds`

**Decision**: If the body carries `total_seconds` (a number `>= 0`, including an explicit `0`), store it verbatim and skip correlation. Only an absent/null `total_seconds` triggers the heartbeat query. Each `POST` is self-contained: a re-post that omits `total_seconds` re-derives rather than preserving a prior client figure.

**Why**: Correlation is a best-effort fallback; an authoritative plugin figure must never be second-guessed. Skipping the query when a value is present also preserves #135's fast single-upsert path for plugins. Re-deriving on an omitted re-post is exactly the existing upsert semantics (#135 D-2: "re-posting … updates the mutable fields in place") — `total_seconds` is a mutable field like any other, so an omitted re-post resolves it the same way a first post does. Documenting this avoids a surprise where a webhook adapter re-post silently changes a stored figure.

**Alternatives rejected**:
- *Correlation overrides a client value* — violates "client knows best"; breaks plugins.
- *A re-post preserves a previously supplied value* — would make the write path stateful (read-before-write to detect prior provenance) and diverge from the documented full-overwrite upsert.

## D-3: Attribution window — `(previous commit | capped floor] … author_date]`

**Decision**: The window is `[lower, upper]` (upper-**inclusive**) where:
- `upper` = the commit's `author_date` epoch (the git author instant ≈ commit moment); when `author_date` is omitted, the ingest instant (`now`), mirroring the read-path `created_at` fallback. The upper bound is inclusive: a heartbeat at exactly `author_date` is the window's last beat, so the coding interval ending at the commit moment counts — parity with `computeDurations`, which counts the interval ending at each heartbeat. Consecutive commits still do not double-count, because `author_date` becomes the next commit's inclusive lower bound (`lower`), so a heartbeat on the shared boundary is the earlier commit's last and the later commit's first beat (disjoint intervals; FR-008).
- `lower` = `max(previous_commit_author_date, upper − MAX_CORRELATION_WINDOW)`, where `previous_commit_author_date` is the greatest `author_date` strictly before `upper` among the **same user's other commits in the same project** (excluding this commit's own `hash`; a null-`author_date` prior is not eligible).

**Why**: The previous-commit bound partitions the timeline so consecutive commits split a session instead of each re-counting it (D-2 of the double-count concern, spec FR-008). The cap (`MAX_CORRELATION_WINDOW = 24h`) bounds the query when there is no recent previous commit (e.g. the first commit after a weekend) and keeps the read bounded (D-6). A day is a natural ceiling for "coding leading to one commit", and the session-gap trimming (D-4) removes idle time inside the window regardless of its width.

**Alternatives rejected**:
- *Unbounded lookback to the previous commit* — a commit after a long gap could scan an arbitrarily wide heartbeat range (CPU/scan risk).
- *A fixed window with no previous-commit bound* — two commits in one session would both count the overlapping heartbeats (double-count).
- *Window keyed on `committer_date`* — `author_date` is the coding-session end the read path already surfaces; `committer_date` can differ on rebases/amends.

## D-4: Session boundaries — reuse the `summaries` gap/timeout rule

**Decision**: Derived seconds = the sum of consecutive in-window heartbeat gaps where `0 < gap <= user.timeout` **that are attributed to the commit's project** — each gap credited to the `project` of its earlier heartbeat, mirroring `computeDurations`. Round to whole seconds. Extract the per-pair gap rule into a shared pure helper used by **both** the cron aggregation (`computeDurations`) and this correlation, and replicate `computeDurations`' `prev.project` attribution (gap the unfiltered per-user stream, do **not** pre-filter the read by project), so the two apply an identical rule and identical attribution.

**Why**: A commit's derived time should be counted the same way the daily `summaries` count the same interval, or the two views of "time spent" contradict each other. `computeDurations` gaps the *unfiltered* per-user timeline and attributes each `[prev, curr)` interval to `prev`'s project; correlation applies the same rule and attribution over the bounded, previous-commit-partitioned window. Sharing the primitive and the attribution (rather than re-implementing either) satisfies Simplicity/DRY and keeps the two **methodologically consistent** — same idle/timeout rule, same project attribution. It is *not* asserted to be byte-identical to a stored daily bucket: correlation's window is previous-commit-partitioned and rounded once, whereas `summaries` day-bucket and round per bucket. Rounding matches `summaries` (`Math.round`).

**Alternatives rejected**:
- *Pre-filtering the heartbeat read to the commit's project before gapping* — diverges from `summaries`: a same-project pair straddling another project's heartbeats would absorb the detour (over-count), and a same-project pair whose true inter-beat gap exceeds the timeout only because of the detour would be dropped (under-count). Gapping the unfiltered stream and attributing by `prev.project` matches `computeDurations` exactly. (Example, `timeout = 900s`, project P: beats `P@0, Q@100, P@150` → project-filtered gives P `150` by absorbing Q; unfiltered-with-attribution gives P `100`, matching `summaries`. Beats `P@0, Q@800, P@1000` → project-filtered drops the `1000 > 900` gap to `0`; unfiltered gives P `800`, matching `summaries`.)
- *A bespoke gap/timeout in the handler* — risks silently diverging from `summaries` after a future tweak.
- *Counting a trailing "last heartbeat" duration* beyond the inter-beat gaps — would over-count relative to `summaries`, which attributes only `[prev, curr)` intervals.

## D-5: Scope — project-only, not branch/`ref`

**Decision**: Scope by `project` at **attribution** time — credit each idle-trimmed interval to the project of its earlier heartbeat and count only the commit's-project intervals (D-4); do **not** pre-filter the heartbeat read by project, and do not filter by branch or the commit's `ref`.

**Why**: A commit's `ref` (e.g. `refs/heads/main` or `main`) and a heartbeat's `branch` need normalization to compare, and a coding session frequently crosses branches (feature branch → main) before a commit. Attributing by `prev.project` (rather than pre-filtering the read) matches exactly how project totals are counted in `summaries` (D-4) and avoids the over/under-count a project pre-filter introduces across project switches. The issue lists branch as *optional*; the conservative choice is to omit it.

**Alternatives rejected**:
- *Filter heartbeats by `ref`/branch* — brittle ref-vs-branch normalization and undercounts cross-branch sessions.

## D-6: Bounded queries within the request CPU budget

**Decision**: The correlation path (only when `total_seconds` is omitted) issues:
1. one PK read of the user's `timeout`;
2. one single-row `SELECT MAX(author_date) FROM commits WHERE user_id = ? AND project = ? AND hash != ? AND author_date < ?` (previous-commit bound);
3. one `SELECT time, project FROM heartbeats WHERE user_id = ? AND time >= ? AND time <= ? ORDER BY time ASC LIMIT CORRELATION_HEARTBEAT_LIMIT` (upper bound **inclusive** so the interval ending at the commit moment counts, per D-3; the full in-window user stream — **not** project-filtered — so gaps can be attributed by `prev.project` per D-4);
then the existing single upsert. The window bounds are computed in epoch seconds (SQLite `strftime('%s', <author_date text>)` converts the UTC datetime text to epoch, avoiding JS-parse ambiguity on the space-separated format). Summing ≤ `CORRELATION_HEARTBEAT_LIMIT` gaps in memory is sub-millisecond.

**Why**: The capped window plus the row `LIMIT` bound the heartbeat read; the existing `idx_heartbeats_user_time` (`user_id, time`) serves the range directly (no project predicate) — no new heartbeat index is required. The previous-commit `MAX(author_date)` lookup already rides the auto-index behind `commits`' `UNIQUE(user_id, project, hash)` constraint: its `(user_id, project)` prefix scopes the scan to this user+project's commit rows (never a full table scan), so a dedicated index is a marginal ordering optimization, not a correctness/scan requirement. The impl MAY still add a covering `idx_commits_user_project_author_date` migration to order the `MAX()` on very large commit tables (single-user commit volumes make it unnecessary; decided in PR2). If the row `LIMIT` is hit (a session denser than the cap), correlation uses the rows it read and yields a lower-bound estimate — never an unbounded scan (documented best-effort). Note the `ORDER BY time ASC LIMIT` keeps the **earliest** rows in an over-cap window, dropping the beats nearest `author_date` (the most recent pre-commit coding); PR2 may instead read `DESC` and reverse to retain the most recent beats — a best-effort refinement, not a correctness change (>5000 heartbeats in a ≤24h window is a beat every <17s sustained for a day, not a realistic single-user cadence).

**Constants**:
- `MAX_CORRELATION_WINDOW = 24 * 60 * 60` (86400 s).
- `CORRELATION_HEARTBEAT_LIMIT = 5000` (mirrors the cron's `HEARTBEAT_LIMIT`; ≥ a day of dense heartbeats at typical cadence).

**Alternatives rejected**:
- *No `LIMIT` / no window cap* — violates the Cloudflare 10ms request budget and the "bounded query, not a full scan" mandate.
- *A new `(user_id, project, time)` heartbeat index* — unnecessary given the capped window; adds write cost for no measured benefit at current scale (Simplicity).

## D-7: Contract change is description-only

**Decision**: No field is added or removed. The `createProjectCommit` operation description is reworded (its "the server does not correlate heartbeats" clause is now false), and `CommitInput.total_seconds` / `Commit.total_seconds` gain descriptions documenting the fill-when-omitted / may-be-derived semantics. `npm run generate` produces a JSDoc-only diff.

**Why**: The behavior lives entirely server-side; the request/response shapes are already sufficient (`total_seconds` is already optional in and nullable out). Adding a provenance field (e.g. `total_seconds_source`) would broaden the contract for no caller need and is explicitly rejected — a caller cannot act differently on "derived" vs "supplied", and the value is authoritative either way.

**Alternatives rejected**:
- *Add a `total_seconds_source` / `derived` flag* — contract bloat, no consumer.
- *Add an opt-out query param to disable correlation* — the omit-vs-supply distinction already expresses intent; a flag is redundant.
