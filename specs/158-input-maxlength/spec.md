# Feature Specification: Maximum lengths on write-input fields

**Feature Branch**: `158-input-maxlength`
**Created**: 2026-06-10
**Status**: Draft
**Input**: GitHub Issue #158. The write-input schemas (`HeartbeatInput`, `CommitInput`, `ExternalDurationInput`, `CustomRuleInput`) define no length bounds; validators check types and enums only, so string fields are limited solely by the global 256 KB request-body cap. Found in the 2026-06-10 security audit.

## Background

Every write endpoint validates structure (types, enums, required fields) but
not size. An authenticated client can persist multi-hundred-kilobyte strings
per field; those values then flow onward into aggregate group-by keys
(`summaries`), the per-project registry (`user_projects`), the device and
user-agent registries (`machine_names.value`, `user_agents.value`), KV-cached
rule sets, and export bundles — multiplying the bloat at every hop.

WakaTime's public API documentation (checked 2026-06-10) documents the
heartbeat fields but specifies **no length limits** — only the 25-item bulk
cap, which CloudTime already enforces. The caps are therefore CloudTime's own
design choice, sized generously from platform invariants (file-system path
maxima, e-mail and URL conventions, commit-hash widths) so that no legitimate
editor plugin or integration can ever hit them; full derivations live in
`research.md`.

Two delivery rules shape the behavior:

- **Body fields reject; ambient headers truncate.** A field the client put in
  the request body is rejected with the existing 400 validation error — the
  client chose the value and can fix it. The `User-Agent` and
  `X-Machine-Name` headers are ambient (plugin users often cannot control
  them), so header-derived values are silently truncated to the same caps
  instead of failing the heartbeat.
- **No new error surface.** Oversized fields produce the same 400 shapes the
  endpoints emit today (per-item errors on bulk endpoints included); no
  status code or response schema changes.

This spec covers PR1 of the SpecKit 2-PR workflow: specification artifacts
plus the `maxLength`/`maxItems` additions to the four input schemas and
regenerated types. Enforcement follows in PR2.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Oversized write-input fields are rejected (Priority: P1)

As an instance operator, I want write requests with absurdly long field
values rejected at validation time so a buggy or abusive client cannot bloat
my database, caches, and aggregates.

**Why this priority**: This is the audit finding — unbounded inputs are a
storage-abuse vector everywhere a written value is re-stored or re-keyed.

**Independent Test**: POST a heartbeat (and a commit, an external duration,
and a custom-rule set) where exactly one field exceeds its cap — each
request returns the endpoint's standard 400 validation error naming the
field, and nothing is persisted for the rejected item.

**Acceptance Scenarios**:

1. **Given** a heartbeat whose `entity` exceeds 4096 characters (or any capped field exceeds its limit), **When** it is POSTed singly, **Then** the response is the standard 400 validation error and no row is written.
2. **Given** a bulk heartbeat request where one item has an oversized field and the others are valid, **When** it is POSTed, **Then** the oversized item reports its per-item 400 error while the valid items persist — exactly today's partial-failure shape.
3. **Given** a commit, external duration, or custom rule with an oversized field, **When** it is submitted, **Then** the endpoint's existing 400 format reports the violating field (bulk external durations keep their all-or-nothing contract).
4. **Given** a `dependencies` array of more than 100 items (or an item longer than 255 characters, or a comma-separated string longer than 8192 characters), **When** the heartbeat is POSTed, **Then** it is rejected with the standard 400.

---

### User Story 2 - Every legitimate client stays unaffected (Priority: P2)

As a user of a WakaTime-compatible editor plugin, I want my heartbeats and
integrations to keep working unchanged, because the caps are far above
anything real clients produce.

**Why this priority**: Compatibility is the project's reason to exist; a cap
that rejects real traffic is a regression, not a defense.

**Independent Test**: The entire existing test corpus passes unmodified, and
boundary cases at exactly the cap (e.g. a 4096-character `entity`, a
255-character `project`) are accepted.

**Acceptance Scenarios**:

1. **Given** any write payload the existing test suite sends today, **When** validation runs with caps enforced, **Then** every such payload is accepted unchanged.
2. **Given** a field at exactly its cap length, **When** submitted, **Then** it is accepted (limits are inclusive).
3. **Given** realistic worst-case values — a deep file path of a few hundred characters, a long git branch name, a verbose commit message — **When** submitted, **Then** they are accepted with ample headroom.

---

### User Story 3 - Ambient header values are truncated, not fatal (Priority: P3)

As a plugin user whose editor sends an unusually long `User-Agent` (or whose
environment injects a long machine name), I want my heartbeats recorded
rather than rejected for something I cannot configure.

**Why this priority**: Headers are not chosen per request by the user;
failing the write would punish the wrong party and lose time-tracking data.

**Independent Test**: Send a heartbeat with a >512-character `User-Agent`
header (and a >255-character `X-Machine-Name` header) — the heartbeat is
accepted and the stored user-agent/machine values are the truncated
prefixes.

**Acceptance Scenarios**:

1. **Given** a heartbeat with an oversized `User-Agent` header and no body `user_agent`, **When** POSTed, **Then** it succeeds and the registered user-agent value is truncated to 512 characters.
2. **Given** an oversized `X-Machine-Name` header and no body `machine`, **When** POSTed, **Then** it succeeds and the registered machine value is truncated to 255 characters.
3. **Given** an oversized `user_agent` or `machine` **body field**, **When** POSTed, **Then** it is rejected with 400 (body fields are chosen by the client and follow User Story 1).

---

### Edge Cases

- **Exactly at the cap**: accepted; caps are inclusive maxima.
- **Multi-byte characters**: limits count UTF-16 code units (the platform's
  native string length), matching how `maxLength` is conventionally
  enforced; documented so clients are not surprised by emoji-heavy values.
- **`dependencies` given as a comma-separated string**: the raw string is
  capped at 8192 before splitting; after splitting, the per-item (255) and
  item-count (100) caps apply to the result.
- **Truncated header collisions**: two distinct >512-char user agents that
  share their first 512 characters register as one — acceptable; the
  registries are best-effort telemetry, not identity.
- **Existing oversized rows** (written before enforcement): unaffected;
  validation applies to new writes only, no migration or backfill.
- **Custom-rule values vs entity matching**: rules may target `entity`
  prefixes, so rule values get a higher cap (1024) than name-like fields.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The API contract MUST declare an inclusive maximum length for every free-text string field of `HeartbeatInput`, `CommitInput`, `ExternalDurationInput`, and `CustomRuleInput`, and a maximum item count for `dependencies`, using the values fixed in `research.md` (R-1…R-4).
- **FR-002**: Validation MUST reject a body field exceeding its cap with the endpoint's existing 400 validation-error format, naming the violating field; bulk endpoints keep their existing per-item (heartbeats) or all-or-nothing (external durations) semantics.
- **FR-003**: A field at exactly its cap MUST be accepted.
- **FR-004**: Values derived from the `User-Agent` or `X-Machine-Name` request headers MUST be truncated to the corresponding cap (512 / 255) instead of causing rejection; body-supplied `user_agent`/`machine` fields follow FR-002.
- **FR-005**: `dependencies` MUST enforce: comma-separated string form ≤ 8192 characters; array form ≤ 100 items; each resulting item ≤ 255 characters.
- **FR-006**: No status codes, response schemas, or success shapes may change; the additions are constraints on already-documented 400 behavior.
- **FR-007**: Length limits MUST be defined once per schema in the API contract and the enforced values MUST match the contract exactly (no drift between spec and validators).

### Key Entities

No new entities; no schema or stored-data changes. The caps constrain four
existing request schemas only.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After enforcement, no single write-input field can persist more than its cap (worst case 8192 characters) — versus ~256,000 today — bounding per-row bloat by a factor of ≥30.
- **SC-002**: 100% of the pre-existing test corpus passes without modification (zero legitimate-traffic regressions).
- **SC-003**: Boundary values at exactly each cap are accepted; values one character over are rejected — verified per schema by tests.
- **SC-004**: Heartbeats with oversized ambient headers are still recorded (no data loss for plugin users), with stored values capped.

## Assumptions

- Caps count UTF-16 code units (native string length), the conventional
  `maxLength` interpretation; byte-exact budgeting is not required since the
  goal is bounding abuse, not precise quotas.
- Generous caps are preferred over tight ones: the threat is megabyte-scale
  abuse, so rejecting at single-digit kilobytes retains full compatibility
  headroom while removing the attack.
- No backfill of pre-existing oversized rows is needed; the hourly cron and
  read paths tolerate them today and they age out with retention.
- The `GoalInput`/`GoalUpdate` `title` cap (200) already exists and is out of
  scope; profile fields already enforce caps in `validateProfileInput`.
- WakaTime compatibility is judged against the public API documentation
  (which documents no limits), per the project's trademark/legal constraint
  against reading WakaTime source code.
