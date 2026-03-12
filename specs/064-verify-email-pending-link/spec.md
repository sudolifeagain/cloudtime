# Feature Specification: Verify Existing User Email Before Creating PendingLink

**Feature Branch**: `064-verify-email-pending-link`
**Created**: 2026-03-13
**Status**: Draft
**Input**: Issue #39 — Add email_verified tracking to users and enforce verification before PendingLink creation

## Clarifications

### Session 2026-03-13

- Q: email_verified がダウングレードされるか（verified → unverified）? → A: ~~常に最新のプロバイダーデータで更新する（ダウングレードあり）。~~ **改訂**: ダウングレードなし（high-water mark 方式）。一度 verified になったら維持する。Auth0/Firebase/Clerk 等の業界標準に準拠。
- Q: Out-of-band メール検証（確認メール送信）をスコープに含めるか？ → A: スコープ外。今回は OAuth プロバイダーの報告のみで判断する。将来の別 issue として切り出す。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - OAuth user creation records email verification status (Priority: P1)

A new user signs up via an OAuth provider (GitHub, Google, Discord). The system records whether the provider reported the user's email as verified. This data forms the foundation for all subsequent verification checks.

**Why this priority**: Without tracking email_verified on the user record, no downstream security checks are possible.

**Independent Test**: Create a new user via OAuth with a verified email and confirm the system records the email as verified. Repeat with an unverified email and confirm the system records it as unverified.

**Acceptance Scenarios**:

1. **Given** a new user signs up via OAuth, **When** the provider reports the email as verified, **Then** the user record is created with email marked as verified.
2. **Given** a new user signs up via OAuth, **When** the provider does not report the email as verified (or omits verification status), **Then** the user record is created with email marked as not verified.
3. **Given** an existing user links an additional OAuth provider, **When** that provider reports a verified email matching the user's current email, **Then** the user's email verification status is upgraded to verified (if not already).
4. **Given** an existing user with a verified email logs in via OAuth, **When** the provider reports the email as unverified, **Then** the user's email verification status remains verified (high-water mark — no downgrade).

---

### User Story 2 - PendingLink only created when existing user's email is verified (Priority: P1)

When a new OAuth login matches an existing user by email, the system now checks whether the existing user's email is verified before creating a PendingLink. This prevents an attacker with a verified provider email from creating a merge request to an account whose email was never validated.

**Why this priority**: This is the core security improvement described in issue #39. Without this check, the PendingLink mechanism relies solely on manual approval as a defense, violating defense-in-depth.

**Independent Test**: Attempt an OAuth login where the provider email matches an existing user with an unverified email. Confirm no PendingLink is created and the system treats the login as a new user instead.

**Acceptance Scenarios**:

1. **Given** an existing user with a verified email, **When** a new OAuth login provides the same email (verified by the provider), **Then** a PendingLink is created for account merge approval.
2. **Given** an existing user with an unverified email, **When** a new OAuth login provides the same email, **Then** no PendingLink is created and a new separate user account is created instead.
3. **Given** an existing user with a verified email, **When** a new OAuth login provides the same email but the provider does not mark it as verified, **Then** no PendingLink is created and a new separate user account is created instead.

---

### User Story 3 - Single-user mode bypasses email verification for direct linking (Priority: P2)

In single-user mode, the system's existing behavior directly links new OAuth providers to the owner without a PendingLink. Since there is only one user and no merge approval flow, the email_verified check is not required for the linking decision. However, the system still records the email_verified status for data completeness.

**Why this priority**: Single-user mode is the default deployment. The email_verified column must be populated correctly even though the security check is only enforced in multi-user mode.

**Independent Test**: In single-user mode, sign in with a second OAuth provider. Confirm the provider links directly to the owner regardless of email verification status, and that email_verified is still recorded on the user record.

**Acceptance Scenarios**:

1. **Given** a single-user instance with one owner, **When** a new OAuth login matches the owner's email, **Then** the provider is linked directly to the owner without creating a PendingLink, regardless of email verification status.
2. **Given** a single-user instance, **When** any OAuth login occurs, **Then** the user's email_verified status is still recorded accurately based on what the provider reports.

---

### Edge Cases

- What happens when a user has no email at all (null email)? No email match is possible, so PendingLink creation via email matching is skipped entirely.
- What happens when two existing users both have the same verified email? The system should match the first user found (by creation date) and create a PendingLink to that user only.
- What happens when an OAuth provider changes a user's email verification status between logins? The system uses a high-water mark approach: once email_verified is set to true, it is never downgraded to false. Only upgrades (false → true) are applied. This follows industry best practices (Auth0, Firebase, Clerk).
- What happens during the migration for existing users who were created via OAuth before this feature? All existing users created via OAuth are assumed to have verified emails (since OAuth providers verified them at the time). The migration sets email_verified to true for users with at least one linked oauth_account.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The user data model MUST include an email verification status field that indicates whether the user's email has been confirmed.
- **FR-002**: When a new user is created via OAuth, the system MUST set the email verification status based on whether the OAuth provider reports the email as verified.
- **FR-003**: On each successful OAuth login or provider linking, the system MUST upgrade the user's email verification status to verified if the provider reports a verified email. Once verified, the status MUST NOT be downgraded (high-water mark).
- **FR-004**: In multi-user mode, the system MUST check that the existing user's email is verified before creating a PendingLink during same-email detection.
- **FR-005**: In multi-user mode, the system MUST also check that the new OAuth provider reports the incoming email as verified before creating a PendingLink.
- **FR-006**: If either the existing user's email is unverified or the incoming provider email is unverified, the system MUST treat the OAuth login as a new user (create a new account) rather than creating a PendingLink.
- **FR-007**: In single-user mode, the system MUST continue to link providers directly without email verification checks, but MUST still record the email_verified status.
- **FR-008**: A data migration MUST set email_verified to true for all existing users who have at least one linked OAuth account.
- **FR-009**: A data migration MUST set email_verified to false for any existing users without a linked OAuth account.

### Key Entities

- **User**: Extended with an email verification status. Represents whether the email on file has been confirmed via a trusted source (OAuth provider reporting verified email). Default for new records: unverified.
- **PendingLink**: No schema changes. Existing entity representing a pending account merge request. Creation is now gated by email verification status of both parties.

## Out of Scope

- **Out-of-band email verification (confirmation email)**: PendingLink 承認時に確認メールを送信して本人確認を行う仕組みは、今回のスコープ外とする。現時点では「手動承認 + email_verified チェック」の2層防御で十分とし、確認メール機能は将来の別 issue として対応する。

## Assumptions

- All three supported OAuth providers (GitHub, Google, Discord) return an email verification status in their user info response. If a provider does not return this field, the email is treated as unverified.
- The `email_verified` field on the provider response is trusted as-is. While the Truffle Security research notes that even verified emails can be spoofed via domain takeover, the PendingLink manual approval flow provides a second layer of defense. This feature adds a third layer (email verification check).
- Existing users created before this feature via OAuth are treated as having verified emails, since OAuth providers verified their emails at account creation time.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: No PendingLink can be created when the existing user's email is unverified — 100% enforcement in multi-user mode.
- **SC-002**: No PendingLink can be created when the incoming OAuth provider does not report the email as verified — 100% enforcement in multi-user mode.
- **SC-003**: All new users created via OAuth have their email verification status accurately recorded based on the provider's response.
- **SC-004**: All existing users have email_verified set correctly after migration (true for users with OAuth accounts, false otherwise).
- **SC-005**: Single-user mode continues to function without regression — provider linking works regardless of email verification status.
