# Research: Maximum lengths on write-input fields

**Branch**: `158-input-maxlength` | **Date**: 2026-06-10

Sources consulted (2026-06-10): WakaTime public API documentation
(`wakatime.com/developers`, heartbeats endpoint — documents fields and the
25-item bulk cap but **no length limits**; the general API rate limit is
"fewer than 10 requests per second on average over any 5 minute period"),
platform invariants (Linux `PATH_MAX`, RFC 5321 §4.5.3.1 address maxima,
git object-name widths, the de-facto 2048-character URL convention).
Per the project constitution, WakaTime **source code was not consulted**.

## R-1: HeartbeatInput caps

**Decision**:

| Field | Cap | Basis |
|---|---|---|
| `entity` | 4096 | Linux `PATH_MAX` (4096) — `entity` carries file paths, and also covers `url`/`domain` types (browser URL convention is 2048) |
| `project`, `branch`, `language`, `editor`, `operating_system`, `machine` | 255 | name-like identifiers; 255 is the classic single-component / VARCHAR convention and ≥4× any observed real value |
| `user_agent` | 512 | UA strings are oversized name-likes; 512 doubles the worst real-world UA we could find |
| `dependencies` (string form) | 8192 | comma-separated list; bounds the raw value before splitting |
| `dependencies` (array form) | maxItems 100, items ≤255 | dependency detection yields dozens at most; 100 names with full 255-char names ≈ 25 KB worst case |

**Rationale**: the threat is multi-hundred-KB fields, not realistic data; caps
4–30× above realistic maxima eliminate the abuse with zero compatibility
risk (spec SC-001/SC-002).

**Alternatives considered**: tighter "realistic" caps (e.g. entity 1024) —
rejected: deep monorepo paths plus URL entities make 1024 conceivably
reachable; the defense gains nothing from tightness. Byte-based caps —
rejected: UTF-16 code-unit counting (`String.length`) matches `maxLength`
convention and is what validators can check for free.

## R-2: CommitInput caps

**Decision**: `hash` 64 (SHA-256 hex width; SHA-1 is 40), `message` 4096,
`author_name`/`committer_name` 255, `author_email`/`committer_email` 254
(RFC 5321 maximum address length), `ref` 255, `url` 2048 (URL convention).

**Rationale**: git object names are fixed-width; the 72-char commit-subject
convention makes 4096 a generous whole-message budget; RFC 5321 is the
canonical email bound; refs beyond 255 don't survive real filesystems.

**Alternatives considered**: pattern-validating `hash` as hex — rejected
here as scope creep beyond #158 (length only); can be a later additive
constraint.

## R-3: ExternalDurationInput caps

**Decision**: `external_id` 255, `entity` 4096, `project`/`branch`/`language`
255, `meta` 8192.

**Rationale**: mirrors heartbeat fields for the shared dimensions;
`external_id` is a foreign system's identifier (UUIDs, ULIDs, calendar event
ids — all ≪255); `meta` is a free-form payload the API stores opaquely, so it
gets the largest budget, aligned with the dependencies-string cap.

## R-4: CustomRuleInput caps

**Decision**: `source_value` and `destination_value` 1024.

**Rationale**: rules may match on `entity`, so values can legitimately be
long path prefixes — 255 would be too tight; 1024 covers any plausible
prefix while keeping the 50-rule KV-cached set ≤ ~100 KB worst case.

**Alternatives considered**: per-source-field caps (255 for names, 4096 for
entity) — rejected: the validator would need the cap to depend on another
field's value; one generous bound is simpler (Principle V) and still 200×
below the abuse scale.

## R-5: Reject bodies, truncate ambient headers

**Decision**: body fields exceeding caps → the endpoint's existing 400
validation error. `User-Agent`-header- and `X-Machine-Name`-header-derived
values → truncated to 512 / 255 at ingestion.

**Rationale**: a body value is chosen by the client and is correctable; an
ambient header often is not (corporate proxies, runtime-composed UA
strings), and losing time-tracking data over it punishes the wrong party.
Truncation bounds storage exactly as well as rejection. Spec FR-002/FR-004.

**Alternatives considered**: rejecting on oversized headers — rejected (data
loss for users who can't fix it); truncating body fields — rejected
(silently storing something other than what the client sent corrupts
round-trips; contract-clean rejection is honest).

## R-6: Single source of truth for the values

**Decision**: PR2 defines all caps once in `src/utils/input-limits.ts`; the
four validators import from it; a parity unit test pins each constant to the
documented value.

**Rationale**: `maxLength` in OpenAPI does not surface in generated TS types
(openapi-typescript emits `string` regardless), so the type system cannot
hold spec↔validator parity — a constants module plus a pinning test is the
lightest drift guard (FR-007).

**Alternatives considered**: generating validators from the schema (e.g.
ajv at runtime) — rejected: a new runtime dependency and validation model
for one class of check (Principle V); deriving constants from the bundled
YAML at build time — rejected: build tooling complexity for four files.

## R-7: No migration / backfill

**Decision**: enforcement applies to new writes only; pre-existing oversized
rows (if any) are left alone.

**Rationale**: read paths and the cron already tolerate them; raw heartbeats
age out under `HEARTBEAT_RETENTION_DAYS`; a backfill would be a destructive
scan for a hypothetical.
