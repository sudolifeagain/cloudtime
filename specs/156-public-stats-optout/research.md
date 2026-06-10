# Research: Instance-level opt-out for the public global stats endpoint

**Branch**: `156-public-stats-optout` | **Date**: 2026-06-10

No `NEEDS CLARIFICATION` markers remained in the spec — Issue #156 fixed the
contentious decisions up front. This document records those decisions and the
alternatives considered.

## D-1: Disabled response is `404`, not `403`

**Decision**: When `PUBLIC_STATS="false"`, `GET /api/v1/stats/{range}` returns
`404 Not Found` with the standard error body.

**Rationale**: A `403` confirms to a prober that the endpoint exists and is
deliberately guarded — exactly the information a privacy-motivated operator
wants to withhold. `404` is indistinguishable from the endpoint never having
existed. The shared `NotFound` response component
(`schemas/components/responses/NotFound.yaml`) already models this body, so no
new schema is needed.

**Alternatives considered**:
- `403 Forbidden` — rejected: leaks endpoint existence (spec FR-004).
- `401` + auth requirement — rejected: turns a public endpoint into an
  authenticated one, a breaking contract change; out of scope.
- Empty/zeroed `200` — rejected: still confirms the endpoint and invites
  clients to treat fabricated zeros as data.

## D-2: Default is enabled (fail-open for unrecognized values)

**Decision**: Unset, `"true"`, or any unrecognized value ⇒ enabled. Only the
literal `"false"` (trimmed, case-insensitive) disables.

**Rationale**: Existing deployments must observe zero behavior change on
upgrade (spec SC-002); dashboards or badges built on the endpoint must not
break silently. The privacy posture is an explicit operator opt-in,
recommended prominently in the deployment guide (PR2).

**Alternatives considered**:
- Privacy-by-default (`disabled` unless `PUBLIC_STATS="true"`) — rejected for
  this change: a silent breaking flip for every existing instance. Revisitable
  as a major-version default change.
- Defaulting by `INSTANCE_MODE` (disabled when `single`) — rejected: same
  silent-flip problem for the project's default mode, and couples two
  unrelated knobs.

## D-3: Value parsing — single documented literal

**Decision**: `(value ?? "").trim().toLowerCase() === "false"` disables;
everything else enables.

**Rationale**: One unambiguous value is trivial to document and test. Trimming
and case-folding absorb the common copy-paste accidents (`"False"`, trailing
space) without growing an alias vocabulary. Constitution Principle V.

**Alternatives considered**:
- Falsy-alias set (`"0"`, `"no"`, `"off"`) — rejected: more surface to
  document and test for no real operator benefit.
- Strict validation with an error on unrecognized values — rejected: Workers
  has no startup hook to fail fast in; failing per-request would turn a typo
  into an outage of the backward-compatible default.

## D-4: Gate placement — top of the handler, not middleware or registration

**Decision**: An early-return check at the top of the `getGlobalStats`
handler in `src/routes/meta.ts`, before range validation, the KV cache read,
and the D1 batch.

**Rationale**: Hono routes are registered at module scope, where no `env` is
available — conditional route registration is not possible on Workers.
A per-route middleware would be indirection around a two-line check
(Principle V). Placing the gate first satisfies FR-002/FR-003: every request
answers `404` with zero cache/DB work and without revealing whether the range
was valid.

**Alternatives considered**:
- Conditional route registration — not feasible (no `env` at module scope).
- Dedicated middleware — rejected: one consumer, no reuse, more files.
- Gate after range validation (400 for bad ranges) — rejected: a differing
  status confirms the endpoint exists (FR-002, spec Edge Cases).

## D-5: Cache handling across the toggle

**Decision**: No purge mechanism. The gate precedes the cache read, so
entries cached while enabled are never served while disabled; they expire on
the existing 5-minute TTL (`global-stats:{range}` keys).

**Rationale**: Toggling requires a redeploy (Workers vars are immutable at
runtime), which takes longer than the TTL anyway; purge code would be dead
weight (Principle V).

**Alternatives considered**:
- Explicit KV purge on first disabled request — rejected: requires KV
  list/delete work on a path whose contract is "do no work", for entries that
  expire in minutes on their own.

## D-6: OpenAPI representation

**Decision**: Add a `404` response to the `getGlobalStats` operation,
`$ref`-ing the shared `NotFound` component, with a description naming the
disabled-instance case, plus one sentence in the operation prose documenting
`PUBLIC_STATS`. Additive change only.

**Rationale**: SDD — the contract must document every response the endpoint
can produce, and the disabled case must be discoverable from the schema
(FR-007). Reusing `NotFound` keeps the generated types additive.

**Alternatives considered**:
- A bespoke `StatsDisabled` response component — rejected: the body is the
  standard error shape; a new component implies a new shape that doesn't
  exist.
- Leaving the 404 undocumented ("operational behavior") — rejected: violates
  SDD; clients deserve to know a permanent 404 is a documented state.

## D-7: Relationship to multi-user per-user visibility

**Decision**: Independent and composable. This switch removes the endpoint at
the instance level; the planned `users.is_public` filter
(`docs/multi-user-design.md` §"Public global stats becomes opt-in-scoped")
scopes the aggregate's contents in multi-user mode.

**Rationale**: A multi-user operator may want the endpoint gone entirely
(this switch) or present but opt-in-scoped (`is_public`). Neither subsumes
the other; when both exist, the instance switch wins (endpoint absent ⇒
scoping moot).

**Alternatives considered**:
- Waiting for `is_public` and deriving instance behavior from it — rejected:
  multi-user visibility is unscheduled future work and does not help the
  single-user owner today (the audit's actual finding).
