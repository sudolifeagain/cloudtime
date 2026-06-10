# Feature Specification: Optional owner allowlist for the single-user first login

**Feature Branch**: `157-owner-allowlist`
**Created**: 2026-06-10
**Status**: Draft
**Input**: GitHub Issue #157. In single-user mode, whoever completes an OAuth login first becomes the permanent instance owner. The race window runs from the moment the Worker URL is reachable until the operator logs in themselves; today the only mitigation is operational discipline (`docs/deployment-guide.md` §"Critical: First-login owner race"). Found in the 2026-06-10 security audit.

## Background

Single-user mode bootstraps its owner on first OAuth login: the user-creation
statement is guarded by an atomic "only if no users exist" condition
(`src/routes/auth/login.ts`), which makes the claim race-free between
concurrent requests — but not identity-bound. Anyone who discovers the Worker
URL before the operator's first login can claim the instance permanently;
recovery is destructive (re-bootstrap, ibid.).

This feature adds an optional instance variable `ALLOWED_OWNER_EMAIL` that
binds the bootstrap to an identity the operator controls. When set, the
new-user creation path in single-user mode only accepts an OAuth identity
whose **provider-verified email** equals the configured value; everyone else
receives the same rejection the instance already gives once registration is
closed, so probing cannot reveal that an allowlist exists.

Design decisions fixed by Issue #157 (full rationale in `research.md`):

- **One variable, matched on the verified email**, uniform across GitHub,
  Google, and Discord. Stable provider IDs are undiscoverable before first
  login; usernames are not uniformly unique across providers. The callback's
  existing email-verified gate makes the email trustworthy — verifying an
  address at a provider requires inbox access.
- **Bootstrap-only scope.** The check gates only new-user creation in
  single-user mode. Existing-owner logins, account linking, the PendingLink
  flow, and multi-user mode are untouched. Unset (or blank) = no change.
- **Indistinguishable rejection.** Mismatches get the existing
  registration-closed `403`; detail (provider + candidate email domain, never
  the full address) goes to operator logs only.

The instance variable is orthogonal to `GOOGLE_HOSTED_DOMAIN` (both may
apply) and to the planned multi-user invite registration (#148).

This spec covers PR1 of the SpecKit 2-PR workflow: specification artifacts
plus a documentation paragraph in the OAuth callback operation description
(no status-code or response-shape change — `403` is already part of the
contract) and regenerated types. Implementation follows in PR2.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Operator pins the owner identity before sharing the URL (Priority: P1)

As an operator deploying a single-user CloudTime instance, I want to declare
up front which account may become the owner, so that discovering my Worker
URL before my first login is no longer enough to take over the instance.

**Why this priority**: This is the entire feature — it closes the audit's
first-login race finding at the code level instead of relying on operator
speed.

**Independent Test**: With `ALLOWED_OWNER_EMAIL` set and an empty users
table, complete an OAuth identity flow whose verified email differs from the
configured value — the response is the registration-closed `403` and no user
is created. Repeat with the matching email — the owner is created and logged
in normally.

**Acceptance Scenarios**:

1. **Given** an empty instance with `ALLOWED_OWNER_EMAIL=owner@example.com`, **When** a first login arrives whose provider-verified email is `owner@example.com`, **Then** the owner account is created and the login completes exactly as today.
2. **Given** the same instance, **When** a first login arrives whose provider-verified email is any other address, **Then** the response is the existing registration-closed `403` body, no user row is created, and the instance remains claimable by the allowed identity.
3. **Given** the same instance, **When** a first login arrives whose provider reports no verified email usable for matching, **Then** it is rejected the same way (a configured allowlist never falls open).
4. **Given** matching is in effect, **When** the configured value and the provider email differ only in letter case or surrounding whitespace, **Then** they still match (trimmed, case-insensitive comparison).

---

### User Story 2 - Existing instances and the owner's daily logins are unaffected (Priority: P2)

As the owner of an already-bootstrapped instance (or an operator who never
sets the variable), I want nothing about login, linking, or registration
behavior to change.

**Why this priority**: The feature must be a pure opt-in; any regression to
the established login flow is unacceptable.

**Independent Test**: With the variable unset, all existing auth flows behave
as today. With it set on an instance whose owner already exists, the owner's
logins (matching email or not — their OAuth account is already linked) and
provider-linking flows behave as today.

**Acceptance Scenarios**:

1. **Given** `ALLOWED_OWNER_EMAIL` is unset or blank (empty/whitespace-only), **When** any login arrives, **Then** behavior is unchanged from the current release.
2. **Given** the owner already exists and the variable is set, **When** the owner logs in via an already-linked provider account, **Then** the login succeeds regardless of that account's email — the allowlist gates only new-user creation.
3. **Given** the owner already exists, **When** a stranger attempts a first login, **Then** they receive the same registration-closed `403` as today (the allowlist adds no new observable behavior after bootstrap).
4. **Given** the variable is set, **When** the owner links an additional provider via the authenticated linking flow, **Then** linking behaves as today (the allowlist does not constrain linking).

---

### User Story 3 - Rejection reveals nothing about the configuration (Priority: P3)

As an operator, I do not want rejected probes to learn whether an allowlist
is configured or what address it expects.

**Why this priority**: Defense-in-depth; an attacker who learns the gating
attribute could target the owner's mailbox or provider account instead.

**Independent Test**: Compare the rejection produced by the allowlist with
the rejection produced by closed registration — status and body are
identical. Operator logs carry the distinguishing detail instead.

**Acceptance Scenarios**:

1. **Given** an allowlist mismatch, **When** the requester inspects the response, **Then** the status and body are byte-identical to the registration-closed rejection.
2. **Given** an allowlist mismatch, **When** the operator inspects the logs, **Then** a log line identifies the rejection reason, the provider, and the candidate email's domain — never the full address.

---

### Edge Cases

- **Blank configuration** (`""` or whitespace-only): treated as unset — the
  gate is skipped entirely, preserving current behavior rather than locking
  everyone out on a copy-paste accident.
- **No verified email from the provider while the variable is set**: counts
  as a mismatch (fail closed). The callback's existing email-verification
  gate already rejects most such logins before this check.
- **Multi-user mode**: the variable is ignored entirely; multi-user
  registration policy is owned by the invite-registration plan (#148).
- **Allowlist set after the owner already exists**: no effect — the gate sits
  on the new-user creation path, which closed at bootstrap. It does not lock
  out an existing owner whose email differs from the configured value.
- **Interplay with `GOOGLE_HOSTED_DOMAIN`**: independent checks; a Google
  login must satisfy both when both are configured.
- **Race between two allowed-email logins**: unchanged — the existing atomic
  only-if-no-users guard still decides the winner.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support an optional instance configuration variable `ALLOWED_OWNER_EMAIL`; when unset, empty, or whitespace-only, all behavior MUST be unchanged from the current release.
- **FR-002**: When the variable is set and the instance runs in single-user mode, the new-user creation path of the OAuth login callback MUST proceed only if the identity's provider-verified email equals the configured value under trimmed, case-insensitive comparison.
- **FR-003**: When the variable is set, an identity with no provider-verified email available for matching MUST be rejected (the gate fails closed).
- **FR-004**: A rejected first login MUST receive a response identical in status and body to the existing registration-closed rejection, so responses do not reveal whether an allowlist is configured.
- **FR-005**: Each allowlist rejection MUST be recorded in operator logs with the rejection reason, the provider, and the candidate email's domain; the full candidate address MUST NOT be logged.
- **FR-006**: The gate MUST apply only to new-user creation in single-user mode: existing-user logins, the authenticated provider-linking flow, the PendingLink flow, and multi-user mode MUST be unaffected.
- **FR-007**: The OAuth callback operation's API documentation MUST describe the owner-allowlist behavior (no status-code or response-shape change — the documented `403` is reused).
- **FR-008**: Operator documentation MUST cover the variable: a commented entry in `wrangler.toml` and an update to the deployment guide's first-login-race section presenting it as the code-level mitigation alongside the existing operational steps.

### Key Entities

- **Instance configuration (`ALLOWED_OWNER_EMAIL`)**: a deployment-time variable, not persisted data. No schema or stored-data changes are involved.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With the variable set, zero non-matching identities can claim an unbootstrapped instance, regardless of how early they discover the URL — the first-login race is reduced to identities controlling the configured mailbox/provider account.
- **SC-002**: Deployments that do not set the variable observe zero behavioral difference (100% backward compatibility).
- **SC-003**: An operator can enable the protection with a single configuration change before first deploy, and the deployment guide documents it next to the existing race warning.
- **SC-004**: Rejected probes receive responses indistinguishable from a closed instance; configuration details appear only in operator logs.

## Assumptions

- The provider-verified email is an acceptable owner identifier: all three
  supported providers expose one, and the callback already refuses logins
  whose email the provider has not verified. An attacker cannot get a
  provider to mark someone else's address as verified without inbox access.
- A single allowed address (not a list) is sufficient for the single-user
  bootstrap; the variable name stays singular and the simplest contract wins
  (Simplicity First). A list can be added compatibly later if ever needed.
- Workers vars are immutable at runtime; changing the value requires a
  redeploy. The gate is read per login attempt, so a redeploy takes effect
  immediately.
- The rejection-body reuse means no API contract change: the callback's
  documented `403` response already covers this case.
- Logging only the email domain follows the established log-hygiene pattern
  used by the hosted-domain restriction and the email-delivery path.
