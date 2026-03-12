# Research: Verify Existing User Email Before Creating PendingLink

**Date**: 2026-03-13 | **Branch**: `064-email-verified-pendinglink`

## R0: Security Literature Review

**Sources reviewed**:
- Microsoft MSRC "Pre-hijacking Attacks on Web User Accounts" (USENIX Security 2022)
- Truffle Security "Google OAuth is Broken (Sort Of)" (Jan 2025)
- RFC 9700 "Best Current Practice for OAuth 2.0 Security" (Jan 2025)
- OWASP Authentication Cheat Sheet & OAuth2 Cheat Sheet
- Google OAuth Account Linking documentation (updated Jan 2025)

### Key findings

**1. Classic-Federated Merge Attack (Microsoft, 2022)**:
An attacker creates an account with the victim's email via a classic (password) route. When the victim later signs up via OAuth with the same email, the service merges the accounts — giving the attacker access. Microsoft found 35 of 75 major services vulnerable. Recommended mitigations:
- Verify email addresses upon account creation
- Never auto-merge accounts; require approval from both account holders
- Check that the user currently controls both accounts before merging

**Our plan's alignment**: CloudTime already requires manual PendingLink approval (not auto-merge). Adding `email_verified` gating is an additional defense-in-depth layer. **PASS**.

**2. Google OAuth domain takeover (Truffle Security, 2025)**:
Anyone can buy a failed startup's domain, re-create employee email accounts, and use them to OAuth-sign-in to third-party services. Google's `sub` claim is the only stable identifier, but it changes in ~0.04% of logins. Google now recommends: "Always use the `sub` field as it is unique to a Google Account, not the `email` field."

**Our plan's alignment**: CloudTime uses `provider_user_id` (sub) for primary OAuth matching. Email is only used as a secondary hint for PendingLink suggestions, which require manual approval. **PASS**.

**3. RFC 9700 (IETF, 2025)**:
Mandates PKCE for all client types, exact redirect URI matching, one-time authorization codes. Does not directly address account linking, but emphasizes defense-in-depth and minimizing implicit trust in email claims.

**Our plan's alignment**: PKCE and redirect URI validation already implemented. Plan adds email trust gating. **PASS**.

### Gaps identified from literature review

**Gap 1 — Security audit logging**: Microsoft's research emphasizes logging pre-hijacking attempts for detection. The current plan does not explicitly require logging when a PendingLink is skipped due to unverified email or when an unverified user's email is cleared. **Recommendation**: Add `console.error` logging for both security events to aid in incident investigation.

**Gap 2 — Session invalidation on email clear**: When clearing an unverified user's email (Option B), the unverified user's active sessions remain valid. In the current system this is low risk (all users are OAuth-created with verified emails), but if manual registration is added in the future, this could allow an attacker to maintain access after losing their email claim. **Recommendation**: Document as a future consideration, not a current blocker (no manual registration exists yet).

## R1: D1 Schema Migration Strategy

**Decision**: Use `ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0` followed by a backfill UPDATE.

**Rationale**: D1 (SQLite) supports `ALTER TABLE ADD COLUMN` with a DEFAULT value. SQLite stores the default in the table schema definition and applies it lazily — this is a non-blocking operation even with existing rows. The backfill UPDATE sets `email_verified = 1` for users with verified OAuth accounts. Confirmed via Cloudflare community docs and D1 SQL statements reference.

**Alternatives considered**:
- Recreate table with new schema (DROP + CREATE + INSERT): Unnecessary complexity; ALTER TABLE works for adding a column with default.
- Application-level default (NULL column + COALESCE): Adds runtime overhead on every query; better to set the default at the schema level.

## R2: Email Match Query Modification

**Decision**: Modify the email match query in `login.ts` (line 167) from `SELECT id FROM users WHERE email = ?` to `SELECT id, email_verified FROM users WHERE email = ?`, then branch on `email_verified`.

**Rationale**: Fetching `email_verified` in the same query avoids a second round-trip. The branching logic is straightforward: if `email_verified = true`, proceed with PendingLink creation (existing flow); if `false`, clear the existing user's email and fall through to new user creation.

**Alternatives considered**:
- Add `AND email_verified = 1` to the WHERE clause: This would silently skip the match when unverified, but we need to actively clear the existing user's email (per clarification). A simple WHERE filter wouldn't trigger the email cleanup.

## R3: Email Cleanup for Unverified Users

**Decision**: When the existing user has `email_verified = false`, execute `UPDATE users SET email = NULL, modified_at = datetime('now') WHERE id = ?` before falling through to new user creation. Log this as a security event.

**Rationale**: This resolves the UNIQUE constraint collision (per clarification session). The unverified user loses their email claim, and the new OAuth user gets the verified email. The UPDATE is a single D1 statement with negligible cost. Per the Microsoft pre-hijacking research, this action should be logged for security auditing.

**Alternatives considered**:
- Batch the UPDATE with the new user INSERT via `db.batch()`: Recommended approach — add the UPDATE to the existing batch (INSERT user + INSERT oauth_account) for atomicity.

## R4: PendingLink Approval — Setting email_verified

**Decision**: In `link.ts`, after the PendingLink is approved (batch INSERT into oauth_accounts + DELETE pending_link), add an UPDATE to set `users.email_verified = 1` if the pending link's `email_verified = 1`.

**Rationale**: When a user approves a PendingLink from a provider with a verified email, the user's account-level email should be marked as verified (high-water mark behavior). This can be added to the existing `db.batch()` call.

**Alternatives considered**:
- Only set email_verified during user creation: Misses the case where an existing user gains verification through a newly linked provider.

## R5: OpenAPI Spec Change Scope

**Decision**: Add `email_verified` (boolean) to the User schema in `schemas/openapi.yaml`. This field appears in the GET /session response (user object).

**Rationale**: The field should be visible to the frontend so it can display verification status. Per SDD, the spec must be updated first, then types regenerated, then implementation committed.

**Alternatives considered**:
- Internal-only field (not exposed via API): Reduces transparency; the frontend may need to display verification badges or warnings in the future.
