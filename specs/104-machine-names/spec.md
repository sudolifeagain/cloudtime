# Feature Specification: Machine Names Endpoint

**Feature Branch**: `104-machine-names`
**Created**: 2026-05-29
**Status**: Draft
**Input**: The `machine_names` D1 table and the `getMachineNames` OpenAPI operation are declared, but no route is mounted and the table is never populated. `POST /heartbeats` already extracts a `machine` value (body field / `X-Machine-Name` header) and stores it on the `heartbeats` row, but no per-device registry is maintained.

## Background

A self-hosted user with multiple devices (work laptop + home desktop) sends heartbeats tagged with a `machine` name, but cannot see a per-device breakdown — the `machine_names` table that would back such a view is empty. This feature populates that registry at ingestion time and exposes it read-only.

It mirrors the `user_agents` feature (#105): a small side-registry kept current by heartbeat ingestion, surfaced by a single list endpoint. **Difference**: `machine` stays a raw string on the `heartbeats` row (no foreign key); `machine_names` is an independent per-device registry, not a normalisation target.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Devices are registered at ingestion (Priority: P1)

As an authenticated user, I want each device I send heartbeats from to be recorded automatically, so the list reflects my real devices without manual setup.

**Independent Test**: POST a heartbeat with `machine="laptop"`, then POST another with `machine="desktop"`; confirm `machine_names` holds two rows for the user, each with a `last_seen_at`. POST a third `machine="laptop"` heartbeat and confirm the `laptop` row's `last_seen_at` advances (no duplicate row).

**Acceptance Scenarios**:
1. **Given** a heartbeat with a `machine` value, **When** ingested, **Then** a `machine_names` row for `(user_id, value)` exists.
2. **Given** a repeat `machine` value, **When** ingested again, **Then** the existing row's `last_seen_at` (and `ip`) updates; no duplicate row (UNIQUE `(user_id, value)`).
3. **Given** a heartbeat with no `machine` value, **When** ingested, **Then** no `machine_names` row is created.
4. **Given** a bulk POST with several heartbeats sharing one `machine`, **When** ingested, **Then** that device is upserted once (not once per heartbeat).

---

### User Story 2 - List my machines (Priority: P1)

As an authenticated user, I want to list my devices most-recently-active first so I can see where my coding time comes from.

**Independent Test**: With two devices registered, `GET /machine_names` returns both as `{"data": Machine[]}` ordered by `last_seen_at` descending, each with `id`, `value`, `last_seen_at`, `created_at`, and the owner-private `ip`.

**Acceptance Scenarios**:
1. **Given** registered machines, **When** listing, **Then** they return ordered by `last_seen_at` descending.
2. **Given** no machines, **When** listing, **Then** the response is `{"data": []}` with 200.
3. **Given** another user's machines, **When** listing, **Then** none appear (strict per-user isolation).
4. **Given** an unauthenticated request, **Then** 401.

---

### Edge Cases

- **`machine` present but `ip` unavailable** (no `CF-Connecting-IP`): the row is still upserted with `ip` null.
- **Hidden heartbeats** (custom-rule `hide`, #101): a heartbeat dropped by a hide rule MUST NOT register a machine — device registration follows persistence.
- **Very long / unusual machine strings**: stored as-is (the column is free-text); no parsing as with user agents.
- **Concurrent upserts of the same device**: UNIQUE `(user_id, value)` + `ON CONFLICT` make the upsert idempotent.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: On `POST /heartbeats` and `POST /heartbeats.bulk`, for every persisted heartbeat carrying a non-empty `machine` value, the server MUST upsert a `machine_names` row keyed by `(user_id, value)`, setting `last_seen_at` to now and `ip` to the request's source IP (`CF-Connecting-IP`, else null).
- **FR-002**: A repeat `(user_id, value)` MUST update `last_seen_at`/`ip` in place via `ON CONFLICT`, never insert a duplicate.
- **FR-003**: A bulk request MUST upsert each distinct `machine` value at most once per request.
- **FR-004**: A heartbeat that is not persisted (invalid, or dropped by a `hide` custom rule) MUST NOT register a machine.
- **FR-005**: `GET /api/v1/users/current/machine_names` MUST return the user's machines as `{"data": Machine[]}` ordered by `last_seen_at` descending.
- **FR-006**: Each entry MUST include `id`, `value`, `last_seen_at`, `created_at`, and `ip` (the caller's own; the list is user-scoped so `ip` is never another user's).
- **FR-007**: The endpoint MUST require API-key or session authentication; unauthenticated requests return 401.
- **FR-008**: Results MUST be strictly scoped by `user_id`; no other user's machines appear.

### Non-Functional Requirements

- **NFR-001**: The ingestion upsert MUST stay within the Workers CPU budget — one extra batched statement per distinct machine, folded into the existing heartbeat `db.batch()` (no separate round-trip).
- **NFR-002**: No D1 schema migration; the `machine_names` table already exists with `UNIQUE(user_id, value)`.
- **NFR-003**: The list endpoint MUST issue a single `SELECT`.

### Key Entities *(no schema change)*

The existing `machine_names` table (`id`, `user_id`, `value`, `ip`, `last_seen_at`, `created_at`, `UNIQUE(user_id, value)`, `ON DELETE CASCADE`) covers everything. `heartbeats.machine` continues to store the raw string; no foreign key is added.

## Success Criteria *(mandatory)*

- **SC-001**: After heartbeats from two devices, the user sees exactly two machines, newest-active first.
- **SC-002**: Re-sending from a known device advances its `last_seen_at` without creating a duplicate.
- **SC-003**: A hidden heartbeat does not create a machine row.
- **SC-004**: Cross-user listing never leaks another user's machines or IPs.

## Out of Scope

- **Per-machine activity stats / filtering** of summaries by machine. This is a registry list only.
- **Renaming, merging, or deleting machines.** No mutation endpoints; the registry is ingestion-driven.
- **Foreign-keying `heartbeats.machine`** to `machine_names`. The raw string stays on the heartbeat row.
- **Geo/IP enrichment.** `ip` is stored verbatim, not resolved.
