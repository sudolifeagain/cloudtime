# Research: Optional owner allowlist for the single-user first login

**Branch**: `157-owner-allowlist` | **Date**: 2026-06-10

No `NEEDS CLARIFICATION` markers remained in the spec — Issue #157 fixed the
contentious decisions. This document records those decisions and the
alternatives considered.

## D-1: Identity attribute — the provider-verified email, one variable

**Decision**: A single `ALLOWED_OWNER_EMAIL` matched against the
provider-verified email, uniformly across GitHub, Google, and Discord.

**Rationale**: The operator knows their email before ever logging in;
provider user IDs (GitHub numeric id, Google `sub`, Discord snowflake) are
stable but practically undiscoverable until after a login — useless for
configuring a not-yet-bootstrapped instance. Usernames are not uniformly
unique (Google has no username; Discord global names are display names).
The callback already refuses logins whose email the provider has not
verified, and providers verify addresses by inbox challenge — so a verified
email is proof of mailbox/provider-account control, exactly the identity
property the bootstrap needs.

**Alternatives considered**:
- Per-provider vars (`ALLOWED_OWNER_GITHUB`, …) matching usernames/IDs —
  rejected: three variables with three different semantics, two of which are
  weak (mutable usernames, no Google username) or undiscoverable (IDs).
- An allowlist of multiple addresses — rejected: single-user mode bootstraps
  exactly one owner; a list is dead complexity (Principle V). Compatible to
  add later.

## D-2: Scope — new-user creation in single-user mode only

**Decision**: The gate runs only in the login callback's new-user creation
branch when `INSTANCE_MODE` is single. Existing-user logins, the
authenticated link flow, the PendingLink flow, and multi-user mode are
untouched. Unset/blank variable = gate inactive.

**Rationale**: The audit finding is the bootstrap race — the only moment an
unauthenticated stranger can acquire anything. After bootstrap, the
only-if-no-users guard already closes registration; constraining later
logins would add lockout risk (the owner's email can change at the provider)
for zero security gain. Multi-user registration policy belongs to the
invite-registration design (#148).

**Alternatives considered**:
- Enforcing the email on every owner login — rejected: lockout risk on
  provider-side email changes; no threat addressed (the OAuth account link,
  not the email, is the owner's credential after bootstrap).
- Applying in multi-user mode — rejected: out of scope; #148 owns it.

## D-3: Matching rule — trimmed, case-insensitive equality; fail closed

**Decision**: `allowed.trim().toLowerCase() === email.trim().toLowerCase()`;
a null/absent provider email while the variable is set is a mismatch.
A blank (empty/whitespace-only) variable deactivates the gate.

**Rationale**: Email local-parts are case-insensitive in practice at every
supported provider, and trimming absorbs copy-paste accidents. Failing
closed on a missing email is the safe default for a security gate; the
existing email-verified gate makes that case rare. Blank-deactivates
mirrors how an unset var behaves and prevents a stray space from locking
the bootstrap.

**Alternatives considered**:
- Strict byte equality — rejected: case differences in configured values
  would reject the legitimate owner for no security benefit.
- Unicode/IDN normalization beyond lowercasing — rejected: provider-verified
  addresses are returned in a canonical form; extra normalization is
  speculative complexity.

## D-4: Rejection response — reuse the registration-closed 403

**Decision**: Mismatches return status and body byte-identical to the
existing `403 {"error":"Registration closed. This instance only allows one
user."}`.

**Rationale**: A distinct message would tell a prober that an allowlist
exists and that the instance is unclaimed — both useful to an attacker. The
registration-closed body is already the documented contract for "you cannot
register here" and is what the same request returns five minutes later once
the owner has bootstrapped.

**Alternatives considered**:
- Dedicated "identity not allowed" message — rejected: information leak,
  plus a new documented error string (contract surface) for no operator
  benefit.
- `404` — rejected: the callback endpoint must exist for the OAuth
  round-trip; a 404 here would be incoherent and break provider tooling.

## D-5: Observability — log reason + provider + candidate domain only

**Decision**: One `console.warn` per rejection:
`[owner-allowlist] rejected provider=<p> reason=<email-mismatch|email-missing> candidate_domain=<domain|(none)>`.

**Rationale**: The operator needs to see that the gate fired (and against
whom, roughly) to debug their own typo'd config; the full candidate address
is third-party PII and is never logged — the same hygiene the hosted-domain
restriction (`[google-hosted-domain] rejected …`) and the email pipeline
(`recipient_domain=`) already follow.

**Alternatives considered**:
- Logging the full candidate email — rejected: PII in logs, against the
  established pattern.
- No logging — rejected: a typo'd `ALLOWED_OWNER_EMAIL` would be
  undiagnosable (every login mysteriously "closed").

## D-6: Test strategy — pure helper + first OAuth fetchMock integration test

**Decision**: Extract the matching rule into `src/utils/owner-allowlist.ts`
and unit-test it exhaustively in `tests/security/owner-allowlist.test.ts`.
Additionally attempt the repo's first OAuth-callback integration test using
`fetchMock` from `cloudflare:test` (undici MockAgent): GET
`/api/v1/auth/github` → capture the state cookie and redirect → mock
`github.com/login/oauth/access_token`, `api.github.com/user`,
`api.github.com/user/emails` → GET the callback with code+state+cookie, and
assert the allow/reject matrix end-to-end.

**Rationale**: The security logic must not depend on a novel harness to be
tested — the pure helper carries it. But the gate's placement (only the
new-user branch) is exactly the kind of wiring a unit test cannot see, and
an OAuth integration harness pays for itself for #157's siblings (#148
multi-user, future provider work).

**Fallback**: If the fetchMock harness proves unstable in the workers pool
(e.g., outbound interception conflicts), ship PR2 with helper unit tests
plus a direct-handler test that stubs `exchangeCode`/`fetchUserInfo` is NOT
attempted (module mocking in workers pool is unreliable); instead document
the gap in the PR and fold the harness into a follow-up issue. The helper
tests still cover FR-001/002/003 logic exactly.

## D-7: Configuration surface — `[vars]` or secret, documented next to the race warning

**Decision**: Document `ALLOWED_OWNER_EMAIL` as a commented `wrangler.toml`
`[vars]` entry and amend the deployment guide's "Critical: First-login owner
race" section to present the variable as the code-level mitigation, with
the existing log-in-immediately procedure as the universal baseline.

**Rationale**: The value is not a secret (it gates, it does not
authenticate), so `[vars]` is appropriate; operators who prefer can set it
via `wrangler secret put` identically. Placing the docs inside the existing
race section puts the fix where the warning already is (SC-003).
