# Feature Specification: Optional Google Hosted Domain Restriction

**Feature Branch**: `037-google-hosted-domain`
**Created**: 2026-05-17
**Status**: Draft
**Input**: GitHub Issue #37 — Optional Google hosted domain restriction (security review item L4)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Operator restricts Google login to their Workspace domain (Priority: P1)

As the operator of a CloudTime instance deployed for a single organization using Google Workspace, I want to restrict Google OAuth login to my organization's domain (e.g., `company.com`), so that random Google users outside my organization cannot create accounts on my instance.

Today, Google OAuth on CloudTime accepts any verified Google account. In multi-user mode (a future state), this means any internet user with a Google account can register. Even in single-user mode, the *first* user to complete OAuth wins the seat — which is unsafe if the deployment URL leaks before the legitimate owner registers.

**Why this priority**: This is the primary security improvement for organizational deployments. Without it, a CloudTime instance behind a publicly reachable URL has weak account-creation controls for the Google provider.

**Independent Test**: Set `GOOGLE_HOSTED_DOMAIN=company.com`, complete OAuth as `alice@company.com` → succeeds. Complete OAuth as `bob@gmail.com` → returns 403. Verify no `users` row is created for the rejected account.

**Acceptance Scenarios**:

1. **Given** `GOOGLE_HOSTED_DOMAIN` is unset, **When** any verified Google user completes OAuth, **Then** the existing behavior is unchanged (account created or matched normally).
2. **Given** `GOOGLE_HOSTED_DOMAIN=company.com`, **When** a user with an `id_token` carrying `hd: "company.com"` completes OAuth, **Then** account creation/login proceeds as normal.
3. **Given** `GOOGLE_HOSTED_DOMAIN=company.com`, **When** a user with an `id_token` carrying `hd: "other.com"` completes OAuth, **Then** the server returns `403 Forbidden` with a JSON body `{"error": "Account domain not allowed"}` and no DB write occurs.
4. **Given** `GOOGLE_HOSTED_DOMAIN=company.com`, **When** a user with an `id_token` missing the `hd` claim (e.g., personal `@gmail.com` account) completes OAuth, **Then** the server returns `403 Forbidden` — personal accounts cannot satisfy a Workspace-domain restriction.
5. **Given** `GOOGLE_HOSTED_DOMAIN` contains uppercase characters (e.g., `Company.COM`), **When** the server reads the env var, **Then** comparison against the `hd` claim is case-insensitive.

---

### User Story 2 - Pass `hd` hint to Google's authorization page (Priority: P2)

As an end user logging in from a configured organization, I want Google's authorization page to default to my Workspace account picker, so that I do not have to sift through my personal accounts.

**Why this priority**: This is a UX improvement. The security-critical control is server-side `hd`-claim validation (User Story 1). The `hd` query parameter on the authorization URL is only a hint and is not security-load-bearing.

**Independent Test**: Inspect the redirect URL emitted by `GET /api/v1/auth/google` when `GOOGLE_HOSTED_DOMAIN=company.com`. Verify the URL contains `&hd=company.com`. Repeat with the env var unset — the URL should not contain `hd`.

**Acceptance Scenarios**:

1. **Given** `GOOGLE_HOSTED_DOMAIN=company.com`, **When** the server builds the Google authorization URL, **Then** the URL includes `hd=company.com` as a query parameter.
2. **Given** `GOOGLE_HOSTED_DOMAIN` is unset, **When** the server builds the Google authorization URL, **Then** the URL does **not** include an `hd` parameter (current behavior).
3. **Given** `GOOGLE_HOSTED_DOMAIN=Company.COM`, **When** the server builds the Google authorization URL, **Then** the URL includes the value in its original form (Google itself is case-insensitive on this hint).

---

### User Story 3 - Observability of domain-restricted rejections (Priority: P3)

As an operator, I want a structured log entry whenever a Google login is rejected due to domain restriction, so that I can confirm the restriction is engaged and detect attempted abuse from outside the organization.

**Independent Test**: Trigger an `hd`-mismatch rejection. Verify a single warning log is emitted containing the configured domain (truncated or hashed if PII concerns exist) and the rejection reason. The log MUST NOT contain the user's full email address or the `id_token` itself.

**Acceptance Scenarios**:

1. **Given** a Google login is rejected for domain mismatch, **When** the 403 is returned, **Then** exactly one warning log is emitted recording the event: rule name, expected domain, and a brief reason (e.g., `hd-mismatch` or `hd-missing`).
2. **Given** a 403 response, **When** the log is captured, **Then** it contains no full email address, no `id_token` payload, and no Google `sub` value.

---

### Edge Cases

- **Wildcard / multi-domain organizations**: An operator with multiple Workspace domains (e.g., `company.com` and `company.co.uk`) cannot use a single `GOOGLE_HOSTED_DOMAIN` value. This feature deliberately supports only one domain. Multi-domain support is out of scope.
- **Existing user is rejected after env var added**: An operator who adds `GOOGLE_HOSTED_DOMAIN` after onboarding users with personal Google accounts will silently lock those users out at next login. Documented as expected behavior — operators must understand this trade-off before configuring the restriction.
- **`hd` present but value `gmail.com`**: Personal accounts have no `hd` claim (it is omitted from the `id_token`). If a future Google change ever emits `hd: gmail.com` for personal accounts, our case-insensitive comparison against `GOOGLE_HOSTED_DOMAIN` will reject those correctly.
- **`hd` spoofing risk via authorization URL**: The `hd` query parameter on the authorization URL is purely a UX hint. A user who manually edits the URL or starts authorization from a different entry point can bypass the hint. The security control is the server-side `hd`-claim verification on the validated `id_token` — claim validation runs after JWT signature verification, so the claim cannot be forged.
- **Single-user mode interaction**: In single-user mode, the existing first-user-wins gate already prevents most abuse. The hosted-domain restriction adds defense in depth: even before the first user registers, only domain-matching accounts can complete OAuth. Useful when the deploy URL is leaked before legitimate owner onboarding.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST read an optional `GOOGLE_HOSTED_DOMAIN` environment variable. When unset or empty, all current behavior is preserved (no domain restriction).
- **FR-002**: When `GOOGLE_HOSTED_DOMAIN` is set and non-empty, the system MUST include `hd=<value>` as a query parameter when constructing the Google authorization URL.
- **FR-003**: When `GOOGLE_HOSTED_DOMAIN` is set and non-empty, the system MUST verify the validated `id_token` contains a `hd` claim whose value matches the configured domain (case-insensitive comparison) before completing the callback.
- **FR-004**: If the `hd`-claim verification fails (claim missing, claim value mismatched), the system MUST return `403 Forbidden` with a JSON body `{"error": "Account domain not allowed"}` and `Cache-Control: no-store`, and MUST NOT create or update any `users`, `oauth_accounts`, or `pending_links` row.
- **FR-005**: The `hd`-claim verification MUST run **after** `id_token` signature, `iss`, `aud`, `azp`, `nonce`, and `at_hash` verification — never before. A failed signature must short-circuit before any claim inspection.
- **FR-006**: The system MUST emit exactly one structured warning log per rejection containing: rule name (`google-hosted-domain`), reason (`hd-mismatch` or `hd-missing`), and the configured domain. The log MUST NOT contain the user's email, full `id_token`, or Google `sub`.
- **FR-007**: The OpenAPI schema for `GET /api/v1/auth/google/callback` MUST advertise the `403` response with the error body shape above. The schema description for `GET /api/v1/auth/google` MUST note that the operator can configure a domain restriction via `GOOGLE_HOSTED_DOMAIN`.
- **FR-008**: The restriction MUST apply to the `google` provider only. `github` and `discord` providers MUST be unaffected.

### Non-Functional Requirements

- **NFR-001**: The `hd`-claim comparison MUST be case-insensitive against the configured domain. The comparison MUST NOT use locale-sensitive comparison (e.g., Turkish dotless I) — use `toLowerCase()` on ASCII domain strings.
- **NFR-002**: Configuration changes (`GOOGLE_HOSTED_DOMAIN` set/unset/changed) MUST take effect on the next request without code redeploy beyond `wrangler deploy`.
- **NFR-003**: The added validation MUST add no measurable latency (<1ms) — it is a string comparison on already-validated JWT claims.

### Key Entities *(no database changes)*

No new database tables or columns. The configuration lives in `wrangler.toml` `[vars]` or as a Worker secret.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can enable the restriction by setting one env var without code change, and disable it by unsetting the var.
- **SC-002**: With the restriction enabled, attempts from non-matching domains return 403 with zero DB writes (verified by querying `users` and `oauth_accounts` before and after).
- **SC-003**: With the restriction disabled, behavior is byte-identical to the current implementation (no regression in existing OAuth flows).
- **SC-004**: Total added code is under ~30 LoC in `src/utils/oauth.ts` plus ~5 LoC in `src/types.ts`.
- **SC-005**: GitHub and Discord OAuth flows have zero changes in PR2 diff.

## Out of Scope

- **Multi-domain support** (e.g., a list of allowed domains). Operators with multi-domain organizations must use a different access control mechanism (e.g., Cloudflare Access in front of the Worker).
- **Per-user-id allowlist**. CloudTime intentionally avoids maintaining a separate identity allowlist; access control is via OAuth provider only.
- **`GOOGLE_HOSTED_DOMAIN` validation/sanitization at startup**. We trust the operator to set a valid domain; if they set an invalid one (e.g., `not a domain`), no Google account can satisfy the constraint and the system fails closed — the desired outcome.
- **Migration of existing users on domain change**. If an operator changes `GOOGLE_HOSTED_DOMAIN` mid-deployment, existing users outside the new domain are simply locked out at next login. No automated cleanup of stale rows.
- **GitHub/Discord equivalent restrictions**. GitHub does not expose a workspace concept; Discord's `guilds` scope could provide similar semantics but is a separate feature.
