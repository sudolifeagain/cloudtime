# Feature Specification: Heartbeat Spec WakaTime-CLI Compatibility

**Feature Branch**: `001-heartbeat-spec-compat`
**Created**: 2026-03-11
**Status**: Draft
**Input**: Update heartbeat OpenAPI spec for wakatime-cli compatibility

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Editor plugin sends heartbeats with full metadata (Priority: P1)

A developer uses an editor plugin (VS Code, JetBrains, etc.) that sends heartbeats via wakatime-cli. The CLI includes fields such as `machine` name, `user_agent` string, and `dependencies` as a JSON array. The system MUST accept these fields without rejecting valid heartbeats.

**Why this priority**: Without accepting the full field set from wakatime-cli, editor plugins will encounter errors or lose tracking data. This is the core compatibility requirement.

**Independent Test**: Send a heartbeat with all wakatime-cli fields populated (including machine, user_agent, dependencies as array) and verify it is accepted and stored.

**Acceptance Scenarios**:

1. **Given** a configured editor plugin, **When** wakatime-cli sends a POST /heartbeats with `machine`, `user_agent`, and `dependencies` as `["react", "lodash"]`, **Then** the system accepts it with 201 and returns the created heartbeat.
2. **Given** a heartbeat with `type: "url"` and `category: "meeting"`, **When** submitted via POST /heartbeats, **Then** the system accepts it without validation errors.
3. **Given** a heartbeat with `X-Machine-Name` and `User-Agent` headers, **When** submitted, **Then** the system extracts and stores the machine name and user agent values.

---

### User Story 2 - Bulk heartbeat submission returns compatible response (Priority: P1)

wakatime-cli sends heartbeats in bulk (up to 25 per request) and expects each item in the response to contain `{data: {id}, error}` with an HTTP status code — not a raw `[Heartbeat, code]` tuple.

**Why this priority**: The bulk endpoint is the primary submission path for wakatime-cli. An incompatible response format causes the CLI to fail silently or retry indefinitely.

**Independent Test**: Send a bulk POST with 3 heartbeats and verify each response item matches the `[{data: {id}, error}, code]` format.

**Acceptance Scenarios**:

1. **Given** 3 valid heartbeats, **When** sent via POST /heartbeats.bulk, **Then** the response contains an array of 3 items, each being `[{data: {id: "..."}, error: null}, 201]`.
2. **Given** a mix of 2 valid and 1 invalid heartbeats, **When** sent via POST /heartbeats.bulk, **Then** valid items return `[{data: {id}, error: null}, 201]` and the invalid item returns `[{data: null, error: "..."}, 400]`.

---

### User Story 3 - Querying heartbeats returns enriched response (Priority: P2)

A dashboard or API consumer queries heartbeats for a given day and receives `start`, `end`, and `timezone` fields in each heartbeat record, enabling proper time-range display without client-side calculation.

**Why this priority**: This is a read-path enhancement for API parity with WakaTime/Wakapi. It does not block plugin functionality but improves dashboard compatibility.

**Independent Test**: Send GET /heartbeats?date=2026-03-11 and verify each returned heartbeat includes `start`, `end`, and `timezone` fields.

**Acceptance Scenarios**:

1. **Given** heartbeats exist for 2026-03-11, **When** GET /heartbeats?date=2026-03-11 is called, **Then** each heartbeat in the response includes `start` (unix timestamp), `end` (unix timestamp), and `timezone` (IANA timezone string).
2. **Given** two consecutive heartbeats at t=100 and t=200 (within timeout threshold), **When** queried, **Then** the first heartbeat's `end` equals 200 (the next heartbeat's `start`).
3. **Given** two heartbeats at t=100 and t=1100 (gap exceeds timeout threshold), **When** queried, **Then** the first heartbeat's `end` equals its own `start` (100).

---

### Edge Cases

- What happens when `dependencies` is sent as a comma-separated string instead of an array? The system MUST accept it and normalize it by splitting on commas and trimming whitespace (e.g., `"react, lodash"` → `["react", "lodash"]`).
- What happens when an unknown `category` value is sent (e.g., `"sleeping"`)? The system MUST reject it with a 400 validation error.
- What happens when an unknown `type` value is sent? The system MUST reject it with a 400 validation error.
- What happens when `X-Machine-Name` header is absent? The system MUST accept the heartbeat and store `machine` as null.
- What happens when bulk request contains more than 25 heartbeats? The system MUST reject the entire request with 400.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST accept `url` and `event` as valid entity `type` values in addition to `file`, `app`, `domain`.
- **FR-002**: System MUST accept 5 additional `category` values: `advising`, `meeting`, `planning`, `supporting`, `translating` (total: 21 categories).
- **FR-003**: System MUST accept `dependencies` as either an array of strings (`string[]`) or a comma-separated string. When a string is received, the system MUST normalize it by splitting on commas and trimming whitespace before storage.
- **FR-004**: System MUST accept `machine` and `user_agent` fields in the heartbeat request body.
- **FR-005**: System MUST read `X-Machine-Name` and `User-Agent` request headers and use them as fallback values for `machine` and `user_agent` when body fields are absent.
- **FR-006**: Bulk POST response MUST return each item as a tuple `[HeartbeatBulkItem, code]` where `HeartbeatBulkItem` is `{data: {id: string} | null, error: string | null}`.
- **FR-007**: GET /heartbeats response MUST include `start`, `end` (unix timestamps), and `timezone` (IANA string) fields for each heartbeat. `end` is derived from the next heartbeat's `time` within the same session; if the gap exceeds the timeout threshold (15 minutes), `end` equals `start`.
- **FR-008**: System MUST validate all enum values (`type`, `category`) and reject unknown values with 400.

### Key Entities

- **HeartbeatInput**: The payload sent by editor plugins. Key new attributes: `machine` (string, optional), `user_agent` (string, optional), `dependencies` (string array), expanded `type` and `category` enums.
- **HeartbeatBulkItem**: New response shape for bulk submissions. Contains `data` (object with `id` or null) and `error` (string or null). Replaces raw Heartbeat object in bulk response tuples.
- **Category**: Enum of 21 activity categories describing what the developer is doing.
- **EntityType**: Enum of 5 entity types: `file`, `app`, `domain`, `url`, `event`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All heartbeats sent by wakatime-cli (with full field set including machine, user_agent, dependencies array, new type/category values) are accepted without errors.
- **SC-002**: Bulk heartbeat responses are parsed successfully by wakatime-cli without retry loops or silent failures.
- **SC-003**: GET /heartbeats responses include start, end, and timezone fields for 100% of returned heartbeats.
- **SC-004**: All 21 category values and 5 entity type values pass validation when submitted.

## Clarifications

### Session 2026-03-11

- Q: Should the system accept comma-separated string format for `dependencies` in addition to arrays? → A: Yes, accept both formats and normalize strings by splitting on commas and trimming whitespace.
- Q: How should `end` timestamp be derived for each heartbeat in GET response? → A: Use the next heartbeat's `time` within the same session. If the gap exceeds 15 minutes (timeout threshold), `end` equals `start`.

### Assumptions

- `dependencies` migration from `string` to `string[]` is a spec-only change. The DB column remains TEXT and stores JSON-serialized arrays. No SQL migration is needed.
- `machine` and `user_agent` values from headers are lower priority than values in the request body (body wins if both present).
- `start` equals the heartbeat's `time` field. `end` is derived from the next heartbeat's `time` within the same session (timeout threshold: 15 minutes). Neither is stored separately; both are computed at query time.
- `timezone` in GET response defaults to the user's configured timezone or UTC if not set.
