# Feature Specification: Remove API Key from OAuth Callback Response

**Feature Branch**: `060-remove-callback-apikey`
**Created**: 2026-03-11
**Status**: Draft
**Input**: issue#60の対応として、OAuth callbackのレスポンスからapi_keyフィールドを削除する

## User Scenarios & Testing *(mandatory)*

### User Story 1 - OAuth callback no longer exposes API key (Priority: P1)

A new user completes the OAuth login flow for the first time. The system creates their account and establishes a session, but does NOT return the API key in the callback response. The API key is generated and stored (as a hash) during account creation, but the plaintext is never exposed in the GET callback response. The user retrieves their API key later via the authenticated `POST /api-key` endpoint (which regenerates the key).

**Why this priority**: This is the core security improvement. GET responses are more susceptible to leakage (CDN debug logs, browser extensions, observability tools) than authenticated POST responses. Removing the API key from the callback eliminates this exposure vector entirely.

**Independent Test**: Complete an OAuth login flow as a new user and verify the callback response does NOT contain an `api_key` field, while the user account is still created successfully with a valid session.

**Acceptance Scenarios**:

1. **Given** a new user completing OAuth login, **When** the callback response is returned, **Then** the response contains `user` and `is_new_user: true` but does NOT contain an `api_key` field.
2. **Given** an existing user completing OAuth login, **When** the callback response is returned, **Then** the response is unchanged (it already does not contain `api_key`).
3. **Given** a new user who has just completed OAuth login, **When** they call `POST /api-key` with their session, **Then** they receive a valid API key that works for editor plugin authentication.

---

### Edge Cases

- What happens if a new user never calls `POST /api-key`? The user has a session but no usable API key plaintext. The hashed key exists in the database from account creation, but the plaintext was never exposed. The user can generate a new key at any time via `POST /api-key`.
- What happens to the API key generated during account creation? It is still generated and stored as a hash (ensuring the database record is complete), but the plaintext is discarded without being returned to the user.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The OAuth callback response MUST NOT include an `api_key` field for any response scenario (new user, existing user, or pending link).
- **FR-002**: Account creation during OAuth callback MUST continue to generate and store an API key hash, ensuring the user record is complete.
- **FR-003**: The existing `POST /api-key` endpoint MUST remain the sole method for users to obtain an API key plaintext.
- **FR-004**: The API specification for the callback response MUST be updated to remove the `api_key` field and its description.
- **FR-005**: The callback response description MUST be updated to remove any mention of returning the API key on first-time creation.

### Key Entities

- **OAuth Callback Response**: Response object returned after OAuth login. The `api_key` field is removed. Remaining fields: `user` (User object), `is_new_user` (boolean), `pending_link` (PendingLink object, conditional).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The OAuth callback response contains zero sensitive credentials (API keys, tokens, secrets) in any scenario.
- **SC-002**: New users can successfully obtain a working API key via the existing authenticated endpoint after completing OAuth login.
- **SC-003**: All existing OAuth login flows (new user, existing user, pending link) continue to function correctly without the `api_key` field.

## Clarifications

### Assumptions

- The `POST /api-key` endpoint already exists and works correctly for session-authenticated users. No changes to this endpoint are needed.
- The API key hash is still generated and stored during user creation to keep the database record consistent.
- This change does not affect API key authentication for editor plugins — only the method by which users first obtain their key changes (dashboard settings page instead of callback response).
