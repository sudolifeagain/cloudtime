# Feature Specification: Custom Rules CRUD + Heartbeat Remap

**Feature Branch**: `101-custom-rules-crud`
**Created**: 2026-05-28
**Status**: Draft
**Input**: The `custom_rules` D1 table exists and `getCustomRules` / `updateCustomRules` / `deleteCustomRule` OpenAPI operations are declared, but no route handler is mounted and the heartbeat-ingestion remap they are meant to drive is missing.

## Background

Custom rules let a user rewrite or drop heartbeats as they are ingested, without editing their local WakaTime-compatible plugin config. The two motivating cases:

- **Remap (`change`)**: a project was renamed (`cloudtime-old` → `cloudtime`); a rule remaps the old name so history and new activity roll up together instead of double-counting.
- **Hide (`hide`)**: drop heartbeats matching a pattern (e.g. a `work/` project during personal-time tracking) so they never enter storage or aggregation.

This feature wires the CRUD surface (`GET` / `PUT` / `DELETE`) and the ingestion-time enforcement on `POST /heartbeats` and `POST /heartbeats.bulk`.

## Spec-level reconciliations (resolved in this PR)

The pre-existing schema declared values that this spec finalises:

- **`action`**: `change | delete` → **`change | hide`**. "hide" unambiguously means "drop the heartbeat" (vs `delete`, which reads like "delete the rule").
- **`operation`**: `equals | contains | starts with | ends with` → **`equals | contains | starts_with | ends_with`** (underscore tokens; no embedded spaces). **`regex` is intentionally deferred** — unbounded regex risks the Workers 10ms CPU budget. Adding it later is an additive enum change.
- **`destination` / `destination_value`**: now optional on input — required for `change`, ignored for `hide`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - List my rules (Priority: P1)

As an authenticated user, I want to see my custom rules in the order they are applied so I can reason about their combined effect.

**Independent Test**: Seed three rules with priorities 2, 0, 1. `GET /custom_rules` returns them ordered 0,1,2 as `{"data": CustomRule[]}`.

**Acceptance Scenarios**:
1. **Given** rules with mixed priorities, **When** listing, **Then** they return in ascending `priority` order (ties broken by `created_at`).
2. **Given** no rules, **When** listing, **Then** the response is `{"data": []}` with 200.
3. **Given** another user's rules exist, **When** listing, **Then** none of them appear.
4. **Given** an unauthenticated request, **Then** 401.

---

### User Story 2 - Replace my rule set (Priority: P1)

As an authenticated user, I want to submit my full set of rules in one call so the client can manage them as a single editable list.

**Independent Test**: `PUT /custom_rules` with a two-rule array; verify 200, the response echoes both with server-assigned `id` + `created_at`, and a subsequent `GET` returns exactly those two.

**Acceptance Scenarios**:
1. **Given** a valid array, **When** PUT, **Then** the prior set is fully replaced and the response lists the new rules in application order.
2. **Given** an empty array `[]`, **When** PUT, **Then** all rules are cleared (200, `{"data": []}`).
3. **Given** a `change` rule missing `destination_value`, **When** PUT, **Then** 400 and the existing set is unchanged.
4. **Given** an unknown enum value (e.g. `action: "drop"`), **When** PUT, **Then** 400.
5. **Given** a `hide` rule with no `destination`, **When** PUT, **Then** 200 (destination not required for hide).
6. **Given** rules without `priority`, **When** PUT, **Then** each is assigned its array index as priority.
7. **Given** an unauthenticated request, **Then** 401 and no change.

---

### User Story 3 - Delete a single rule (Priority: P2)

As an authenticated user, I want to remove one rule without resubmitting the whole set.

**Acceptance Scenarios**:
1. **Given** an owned rule, **When** DELETE, **Then** 204 and it is gone from `GET`.
2. **Given** a rule owned by another user (or unknown id), **When** DELETE, **Then** 404, nothing deleted.
3. **Given** an unauthenticated request, **Then** 401.

---

### User Story 4 - Rules rewrite/drop heartbeats at ingestion (Priority: P1)

As an authenticated user, I want my rules applied to incoming heartbeats so renames roll up and hidden activity never lands.

**Independent Test**: With a `change` rule (`source=project, operation=equals, source_value=old, destination=project, destination_value=new`), POST a heartbeat with `project=old`; read it back and confirm it stored as `project=new`. With a `hide` rule matching `project=secret`, POST a heartbeat with `project=secret`; confirm it is not persisted while the request still reports success.

**Acceptance Scenarios**:
1. **Given** a matching `change` rule, **When** a heartbeat is ingested, **Then** the named `destination` column is rewritten before INSERT.
2. **Given** a matching `hide` rule, **When** a heartbeat is ingested, **Then** it is not stored or aggregated, and the response does not reveal which items were dropped.
3. **Given** multiple rules, **When** ingesting, **Then** they apply in ascending priority order; a `change` may set up a later rule's match; once a `hide` matches, remaining rules are skipped for that heartbeat.
4. **Given** no rules, **When** ingesting, **Then** heartbeats are stored unchanged.
5. **Given** a bulk POST mixing matched and unmatched heartbeats, **When** ingested, **Then** only the unmatched/changed ones persist and per-item response order is preserved.

---

### Edge Cases

- **`change` rule whose `source` field is null on the heartbeat** (e.g. no `project`): no match; rule skipped.
- **`change` to the same column it matched** (`source=project`, `destination=project`): allowed (this is the rename case).
- **`change` across columns** (`source=entity`, `destination=project`): allowed; rewrites `project` when `entity` matches.
- **Conflicting rules**: lower-priority (earlier) rules win on the order defined; later rules see already-mutated values. Deterministic by priority then `created_at`.
- **Duplicate priorities**: allowed; `created_at` (then insert order) breaks ties deterministically.
- **Very large rule set**: bounded by validation cap (e.g. 50 rules) to protect the ingestion hot path.
- **Malformed JSON / not an array on PUT**: 400.
- **Stale KV cache after PUT/DELETE**: cache is invalidated on every mutation so the next ingestion reloads.

---

## Requirements *(mandatory)*

### Functional Requirements — CRUD

- **FR-001**: `GET /api/v1/users/current/custom_rules` MUST return the user's rules as `{"data": CustomRule[]}` ordered by `priority` ascending, ties broken by `created_at`.
- **FR-002**: `PUT /api/v1/users/current/custom_rules` MUST replace the entire rule set with the supplied array (full replace, not merge); `[]` clears all rules. The server MUST assign each rule a fresh `id` and `created_at`, and MUST default `priority` to the array index when omitted. Returns `200` with the persisted rules in application order.
- **FR-003**: PUT MUST validate every element: `action` ∈ {change, hide}; `source` / `destination` ∈ the dimension enum; `operation` ∈ {equals, contains, starts_with, ends_with}; `source_value` non-empty; `change` rules require `destination` and non-empty `destination_value`; `hide` rules ignore both. Any violation MUST return `400` and leave the existing rule set unchanged (validate-then-write).
- **FR-004**: `DELETE /api/v1/users/current/custom_rules/{rule_id}` MUST delete an owned rule (`204`). A rule not owned by the caller or an unknown id MUST return `404` (never 403), scoped by `user_id` in the `WHERE` clause.
- **FR-005**: All endpoints MUST require API-key or session authentication; unauthenticated requests return `401` and mutate nothing.
- **FR-006**: PUT and DELETE MUST invalidate the user's cached rule set so subsequent ingestion uses the new rules.

### Functional Requirements — Heartbeat remap

- **FR-007**: `POST /heartbeats` and `POST /heartbeats.bulk` MUST load the user's rule set (cache-backed) and apply rules in ascending priority order to each heartbeat before INSERT.
- **FR-008**: A `change` rule whose heartbeat `source` field satisfies `operation`/`source_value` MUST rewrite the heartbeat's `destination` column to `destination_value` in memory before persistence.
- **FR-009**: A `hide` rule that matches MUST cause the heartbeat to be skipped (not stored, not aggregated). The endpoint MUST still return a per-item success result so a caller cannot tell which heartbeats were dropped. **The exact success-response shape MUST match the WakaTime-compatible bulk-heartbeat contract** — verified against the documented response and compatible CLI expectations during PR2, not by copying upstream source.
- **FR-010**: Rules apply sequentially: a `change` result is visible to later rules; the first matching `hide` ends processing for that heartbeat.
- **FR-011**: Matching is case-sensitive: `equals` exact, `contains` substring, `starts_with` prefix, `ends_with` suffix. No regex.
- **FR-012**: With an empty rule set, heartbeats MUST be stored unchanged (no behavioural change from today).

### Non-Functional Requirements

- **NFR-001**: The rule set MUST be cached (KV) keyed by `user_id`, invalidated on PUT/DELETE, so the ingestion hot path avoids a D1 read per request.
- **NFR-002**: Rule application MUST stay within the Workers 10ms CPU budget: single-digit rule counts, string operations only (no regex), no extra D1 round-trips in the matching loop.
- **NFR-003**: A validation cap (≤ 50 rules per user) MUST bound the per-heartbeat work and the PUT payload.
- **NFR-004**: No D1 schema migration. Uses the existing `custom_rules` table and existing heartbeat columns.

### Key Entities *(no schema change)*

The existing `custom_rules` table (`id`, `user_id`, `action`, `source`, `operation`, `source_value`, `destination`, `destination_value`, `priority`, `created_at`, `ON DELETE CASCADE`) covers everything. `hide` rules store empty strings for `destination` / `destination_value` to satisfy the NOT NULL columns.

## Success Criteria *(mandatory)*

- **SC-001**: A user can list, fully replace, and delete rules through the API with no direct D1 access.
- **SC-002**: A `change` rule renames the matched dimension on newly ingested heartbeats (verified by reading the heartbeat back).
- **SC-003**: A `hide` rule prevents matched heartbeats from being stored, while the request still succeeds and does not disclose which items were dropped.
- **SC-004**: Invalid PUT payloads return 400 and never partially apply.
- **SC-005**: Cross-user DELETE returns 404 and removes nothing.
- **SC-006**: Ingestion latency stays within budget with a representative rule set (≤ 50 rules), with no per-rule D1 reads.

## Out of Scope

- **`regex` operator** (deferred; additive later).
- **Retroactive application** to already-stored heartbeats or `summaries`. Rules affect only new ingestion.
- **Per-rule enable/disable**, dry-run/preview, or a "test this rule" endpoint.
- **POST/PATCH of a single rule.** Mutation is via full-set `PUT` plus single `DELETE`, matching the declared operations.
- **Cross-dimension cascades beyond the documented sequential semantics** (no fixpoint re-evaluation).
