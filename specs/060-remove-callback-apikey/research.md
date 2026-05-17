# Research: Remove API Key from OAuth Callback Response

**Feature Branch**: `060-remove-callback-apikey`
**Date**: 2026-03-11

## Research Summary

Minimal research needed — the change is well-scoped with no unknowns.

## Decision 1: Where users obtain API keys after this change

- **Decision**: Users call the existing `POST /api-key` endpoint (session-authenticated) to obtain or regenerate their API key.
- **Rationale**: The endpoint already exists at `src/routes/auth/sessions.ts` and works correctly. It regenerates the key (replaces the hash) and returns the new plaintext. No new endpoint needed.
- **Alternatives considered**:
  - Store plaintext temporarily in KV for one-time retrieval — rejected as over-engineering (Principle V).
  - New dedicated "reveal key" endpoint — rejected; `POST /api-key` already serves this purpose.

## Decision 2: Keep or remove API key generation during user creation

- **Decision**: Keep generating the API key hash during user creation.
- **Rationale**: The `users.api_key_hash` column has a NOT NULL constraint. Removing key generation would require a schema migration to make the column nullable, which is unnecessary complexity for this change.
- **Alternatives considered**:
  - Make `api_key_hash` nullable and defer generation to `POST /api-key` — rejected; requires DB migration for no user-facing benefit.

## Decision 3: Impact on existing `POST /api-key` behavior

- **Decision**: No changes to `POST /api-key` endpoint.
- **Rationale**: The endpoint regenerates (not reveals) the key. For a new user, calling it replaces the key created during signup with a fresh one. This is acceptable — the user never saw the original key anyway.
