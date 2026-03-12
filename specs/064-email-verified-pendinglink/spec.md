# Feature Specification: Verify Existing User Email Before Creating PendingLink

**Feature Branch**: `064-email-verified-pendinglink`
**Created**: 2026-03-13
**Status**: Draft
**Input**: Issue #39 — Harden PendingLink creation by requiring the existing user's email to be verified before offering account linking.

## Clarifications

### Session 2026-03-13

- Q: When PendingLink is skipped due to unverified existing user email and a new user is created, how should the email UNIQUE constraint collision be handled? → A: Create the new user with the email, and clear the unverified existing user's email to NULL.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - PendingLink blocked when existing user email is unverified (Priority: P1)

A user signs in via OAuth with a verified provider email that matches an existing user account. If the existing user's email was never verified (e.g., the account was created through a future manual registration flow), the system must NOT create a PendingLink. This prevents an attacker from claiming an unverified email and then having a legitimate OAuth user prompted to link into the attacker's account.

**Why this priority**: This is the core security fix. Without it, an attacker who registers with an unverified email can trick a legitimate user into linking their OAuth identity to the attacker's account.

**Independent Test**: Create a user with an unverified email, then attempt OAuth login with a provider-verified email matching that address. The system should skip PendingLink creation and instead create a new, separate user account.

**Acceptance Scenarios**:

1. **Given** an existing user with `email_verified = false` and email "alice@example.com", **When** a new OAuth login arrives with provider-verified email "alice@example.com", **Then** no PendingLink is created, the existing user's email is set to NULL, and a new user account is created with email "alice@example.com".
2. **Given** an existing user with `email_verified = false`, **When** the email match check runs, **Then** the system clears the existing user's email and falls through to new account creation with the verified email.

---

### User Story 2 - PendingLink created when existing user email IS verified (Priority: P1)

When the existing user's email has been verified (either through OAuth-based verification at account creation or through a future email verification flow), the PendingLink creation should proceed as it does today. This preserves the current account-linking experience for legitimate users.

**Why this priority**: Equal priority with Story 1 — together they define the complete behavior change.

**Independent Test**: Create a user via OAuth with a verified email, then attempt login with a different OAuth provider using the same verified email. The system should create a PendingLink as it does today.

**Acceptance Scenarios**:

1. **Given** an existing user with `email_verified = true` and email "bob@example.com", **When** a new OAuth login arrives with provider-verified email "bob@example.com", **Then** a PendingLink is created and the user is prompted to approve the link.
2. **Given** an existing user created via OAuth with a verified provider email, **Then** the user's `email_verified` column is `true`.

---

### User Story 3 - Email verification status set on user creation (Priority: P1)

When a new user account is created via OAuth login with a provider-verified email, the system must record `email_verified = true` on the users table. This ensures that users created through OAuth have their verification status properly tracked at the account level, not just at the provider level.

**Why this priority**: Without this, the check in Story 1 has no verified users to match against — existing OAuth-created users would all have `email_verified = false`.

**Independent Test**: Create a new account via OAuth with a verified email, then query the users table and confirm `email_verified = true`.

**Acceptance Scenarios**:

1. **Given** a new OAuth login with `emailVerified = true` from the provider, **When** a new user account is created, **Then** `users.email_verified` is set to `true`.
2. **Given** a new OAuth login with `emailVerified = false` (blocked earlier in the flow), **Then** the request is rejected before user creation (existing behavior).

---

### User Story 4 - Backfill email verification for existing users (Priority: P2)

Existing user accounts created before this change have no `email_verified` value. Since all current users were created via OAuth with verified emails (the system currently rejects unverified emails at login), the migration should default `email_verified` to `true` for users who have at least one OAuth account with `email_verified = 1`.

**Why this priority**: Important for correctness but lower priority because it's a one-time migration concern. Without the backfill, existing users would lose PendingLink functionality until they re-authenticate.

**Independent Test**: Run the migration on a database with existing users, then verify that users with verified OAuth accounts have `email_verified = true`, and any users without verified OAuth accounts have `email_verified = false`.

**Acceptance Scenarios**:

1. **Given** an existing user with an OAuth account where `oauth_accounts.email_verified = 1`, **When** the migration runs, **Then** `users.email_verified` is set to `true`.
2. **Given** an existing user with no OAuth accounts (hypothetical), **When** the migration runs, **Then** `users.email_verified` defaults to `false`.

---

### Edge Cases

- What happens when a user has multiple OAuth accounts with conflicting email verification states? The user-level `email_verified` should be `true` if ANY linked provider has verified the email.
- What happens when an OAuth provider's email verification status changes after account creation? The user-level `email_verified` is set at creation time and during provider linking; it is not retroactively downgraded.
- What happens when a user changes their email address in a future profile-edit feature? The `email_verified` flag should be reset to `false` until the new email is verified.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST add an `email_verified` attribute (default `false`) to the user account.
- **FR-002**: System MUST set `email_verified = true` on the user account when creating a new user via OAuth with a provider-verified email.
- **FR-003**: System MUST check that the existing user's `email_verified` is `true` before creating a PendingLink during OAuth email matching.
- **FR-004**: If the existing user's email is not verified, the system MUST skip PendingLink creation and clear the unverified existing user's email to NULL. In multi-user mode, a new user account is created with the provider-verified email. In single-user mode, the email cleanup still occurs but new user creation is subject to the existing single-user guard (max one user).
- **FR-005**: System MUST include a data migration that backfills `email_verified = true` for existing users who have at least one linked provider with a verified email.
- **FR-006**: System MUST set `email_verified = true` on the existing user when a PendingLink is approved and the linked provider has a verified email.
- **FR-007**: The PendingLink approval flow MUST continue to work unchanged for users whose email is already verified. (Regression guard — verified by ensuring T010 only updates when `email_verified = 0`; add explicit regression test if test suite is introduced.)
- **FR-008**: System MUST log a security event when PendingLink creation is skipped due to unverified email (including the existing user ID and provider).
- **FR-009**: System MUST log a security event when an unverified user's email is cleared to NULL (including the affected user ID and the email that was cleared).

### Key Entities

- **User**: Gains a new `email_verified` attribute indicating whether the account-level email has been verified through any trusted source (OAuth provider with verified email).
- **PendingLink**: No change. Creation is now gated on the existing user's `email_verified` status.

## Assumptions

- All current users in the system were created via OAuth with verified provider emails (the system rejects unverified emails at login). Therefore, the migration can safely backfill `email_verified = true` for users with verified OAuth accounts.
- Out-of-band email verification (e.g., sending a verification email) is out of scope for this issue. The scope focuses on tracking verification status from OAuth providers. A future manual registration flow would need its own email verification mechanism.
- The `email_verified` flag on the user account is a "high-water mark" — once set to `true`, it is not downgraded if a provider later reports the email as unverified. It can only be reset if the user changes their email address (future feature).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: No PendingLink is ever created when the target user's email is unverified — 100% enforcement of the verification check.
- **SC-002**: All existing users with verified OAuth accounts retain full PendingLink functionality after migration (zero regression).
- **SC-003**: New users created via OAuth with verified emails are immediately eligible for PendingLink matching (`email_verified = true` from creation).
- **SC-004**: The account-linking flow completes with no additional user-facing steps compared to today (no UX regression for verified users).
