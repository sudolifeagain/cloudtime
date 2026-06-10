# Feature Specification: Instance-level opt-out for the public global stats endpoint

**Feature Branch**: `156-public-stats-optout`
**Created**: 2026-06-10
**Status**: Draft
**Input**: GitHub Issue #156. `GET /api/v1/stats/{range}` is unauthenticated (`security: []`) and aggregates **all** rows in `summaries`. In single-user mode the "global" aggregate is the instance owner's entire coding profile — total time, daily average, language/editor/OS breakdowns — exposed to anyone who knows the Worker URL. Found in the 2026-06-10 security audit.

## Background

The global stats endpoint (`GET /api/v1/stats/{range}`, `src/routes/meta.ts`) is public by design, mirroring the WakaTime-compatible notion of an instance-wide activity summary. On a multi-user instance that aggregate is a blend of many users; on a single-user instance — the project's default and primary mode — it is exactly one person's coding profile, readable without credentials.

`docs/multi-user-design.md` (D-2) already plans **per-user** `is_public` scoping for multi-user mode: only opted-in users would contribute to the public aggregate. That work does not help a single-user operator who simply does not want a public profile at all. This feature adds the missing **instance-level** switch: a configuration variable (`PUBLIC_STATS`) that disables the endpoint entirely.

Design decisions fixed by Issue #156:

- **Default enabled.** Existing deployments change nothing and see no behavior change.
- **Disabled means `404 Not Found`, not `403`.** A 403 confirms the endpoint exists and is guarded; a 404 reveals nothing.
- **Disabled means no work.** The handler must answer before touching the cache or the database, so a disabled endpoint cannot be used to generate load against either.

The instance-level switch is orthogonal to the planned per-user `is_public` filter; when multi-user visibility ships, the two compose (instance switch off ⇒ endpoint gone; instance switch on ⇒ aggregate scoped to opted-in users).

This spec covers PR1 of the SpecKit 2-PR workflow: specification, OpenAPI change (documenting the `404` response), and regenerated types. Implementation and tests follow in PR2.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Operator disables the public profile (Priority: P1)

As the operator of a single-user CloudTime instance, I want to turn off the public global stats endpoint so that my coding activity is not readable by anyone who discovers my Worker URL.

**Why this priority**: This is the entire feature — the privacy gap identified by the security audit.

**Independent Test**: Deploy (or run tests) with `PUBLIC_STATS="false"`. Every request to `GET /api/v1/stats/{range}` returns `404` with the standard error body, and neither the stats cache nor the database is touched by the request.

**Acceptance Scenarios**:

1. **Given** `PUBLIC_STATS="false"` and existing activity data, **When** an unauthenticated client requests `GET /api/v1/stats/last_7_days`, **Then** the response is `404` with the standard error body and contains no activity-derived information.
2. **Given** `PUBLIC_STATS="false"`, **When** any range value is requested — valid (`last_30_days`, `2026`, `2026-05`) or invalid (`not_a_range`) — **Then** the response is `404` in every case (the disabled check precedes range validation, so the endpoint's existence is not confirmed by a differing `400`).
3. **Given** `PUBLIC_STATS="false"` and a stats response cached before the switch was flipped, **When** the endpoint is requested, **Then** the response is `404` and the stale cache entry is not served (it expires unused).
4. **Given** `PUBLIC_STATS="false"`, **When** the endpoint is requested repeatedly, **Then** no aggregate is computed and no cache entries are written.

---

### User Story 2 - Existing deployments are unaffected by default (Priority: P2)

As an operator who upgrades CloudTime without reading the changelog, I want the endpoint to keep working exactly as before unless I explicitly disable it.

**Why this priority**: Backward compatibility is a hard requirement; a silent behavior flip would break dashboards, badges, or monitors built on the endpoint.

**Independent Test**: With `PUBLIC_STATS` unset (and again with `PUBLIC_STATS="true"`), `GET /api/v1/stats/{range}` behaves identically to the current release: `200` with data (or `202` while aggregation is pending), `400` for an invalid range, cache populated as today.

**Acceptance Scenarios**:

1. **Given** `PUBLIC_STATS` is unset, **When** a valid range is requested, **Then** the response (status, body shape, caching behavior) is unchanged from current behavior.
2. **Given** `PUBLIC_STATS="true"`, **When** a valid range is requested, **Then** behavior is identical to the unset case.
3. **Given** `PUBLIC_STATS` set to any unrecognized value, **When** the endpoint is requested, **Then** the endpoint behaves as enabled (fail-open to the backward-compatible default; only an explicit `"false"` disables).

---

### User Story 3 - Only the global stats endpoint is affected (Priority: P3)

As a user of the instance, I want my editor plugins, my own dashboards, and the other public utility endpoints to keep working regardless of the switch.

**Why this priority**: Guards against over-reach; the switch must not become an accidental kill-switch for unrelated functionality.

**Independent Test**: With `PUBLIC_STATS="false"`, the public utility endpoints (`/api/v1/meta`, `/api/v1/editors`, `/api/v1/program_languages`, `/api/v1/health`) and every authenticated endpoint (including `GET /api/v1/users/current/stats/{range}`) respond exactly as before.

**Acceptance Scenarios**:

1. **Given** `PUBLIC_STATS="false"`, **When** the other public utility endpoints are requested, **Then** they respond unchanged.
2. **Given** `PUBLIC_STATS="false"` and an authenticated user, **When** the user requests their own stats (`GET /api/v1/users/current/stats/{range}`), **Then** the response is unchanged — the switch governs only the unauthenticated global aggregate.

---

### Edge Cases

- **Invalid range while disabled**: returns `404`, not `400` — the disabled check runs before range validation so probing cannot distinguish "disabled" from "absent".
- **Cache poisoning across the toggle**: entries cached while enabled must not leak after disabling. Because the disabled check precedes the cache read, stale entries are simply never read and expire on their own short TTL. No purge step is required.
- **Unrecognized switch values** (`"False "`, `"0"`, `"no"`, typos): values are trimmed and compared case-insensitively; the literal `false` disables, anything else (including unset) leaves the endpoint enabled. Fail-open to enabled is deliberate — the default must protect existing deployments from accidental breakage, and the privacy posture is opt-in by explicit operator action.
- **Toggling back on**: re-enabling restores current behavior with no migration or cleanup; the next request repopulates the cache normally.
- **Aggregation pending (202) while enabled**: unchanged; the switch does not interact with the pending-aggregation status.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support an optional instance configuration variable `PUBLIC_STATS` with string values; when its trimmed, case-insensitive value equals `"false"` the public global stats endpoint is **disabled**; for any other value, or when unset, it is **enabled**.
- **FR-002**: When disabled, `GET /api/v1/stats/{range}` MUST return `404 Not Found` with the API's standard error body for **every** request, regardless of the range value's validity or the presence of data.
- **FR-003**: When disabled, the handler MUST NOT read or write the stats cache and MUST NOT execute any database queries for this endpoint — the disabled check precedes all other processing, including range validation.
- **FR-004**: The disabled response MUST be `404` (not `403` or any status that confirms the endpoint exists behind a guard).
- **FR-005**: When enabled (set to a non-`"false"` value) or unset, the endpoint's behavior MUST be unchanged from the current release: same status codes (`200`/`202`/`400`), same response bodies, same caching behavior.
- **FR-006**: The switch MUST affect only `GET /api/v1/stats/{range}`. The other public endpoints (`/meta`, `/editors`, `/program_languages`, `/health`) and all authenticated endpoints — including the per-user `GET /users/current/stats/{range}` — MUST be unaffected.
- **FR-007**: The OpenAPI specification MUST document the `404` response on the global stats operation, identifying it as the disabled-instance response.
- **FR-008**: Operator documentation MUST cover the variable: a commented entry in `wrangler.toml` and a section in `docs/deployment-guide.md` recommending that single-user instances disable public stats unless the owner intentionally wants a public profile.

### Key Entities

- **Instance configuration (`PUBLIC_STATS`)**: a deployment-time variable, not persisted data. No schema or stored-data changes are involved.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With the switch disabled, zero coding-activity information (totals, languages, editors, operating systems, date ranges) is retrievable through the public stats URL — every probe yields the same `404` error body.
- **SC-002**: Deployments that change nothing observe zero behavioral difference after upgrading (100% backward compatibility for the unset case).
- **SC-003**: An operator can disable the public profile with a single configuration change and no data migration; the change is effective from the next deployment.
- **SC-004**: An operator reading the deployment guide can locate and apply the setting without consulting source code.

## Assumptions

- Default-enabled (fail-open for unrecognized values) is fixed by Issue #156 to guarantee backward compatibility; the privacy improvement is an explicit operator opt-in.
- Only the literal value `false` (trimmed, case-insensitive) disables the endpoint; documenting one unambiguous value is simpler than enumerating falsy aliases (`0`, `no`, `off`), per the Simplicity First principle.
- The `404` error body reuses the API's existing standard error shape; no new response schema is introduced.
- Cloudflare Workers vars are immutable at runtime, so the switch takes effect on deployment; no live-toggle mechanism is in scope.
- The planned multi-user per-user visibility (`is_public`, `docs/multi-user-design.md`) remains future work; this switch neither depends on it nor blocks it.
- Rate limiting for this endpoint (Issue #159) is out of scope here; the disabled path's early return already minimizes its cost.
