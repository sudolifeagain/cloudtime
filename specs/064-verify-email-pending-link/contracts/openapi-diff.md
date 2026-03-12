# OpenAPI Contract Changes

**Feature**: 064-verify-email-pending-link
**Date**: 2026-03-13

## User Schema: Add `email_verified`

**Location**: `schemas/openapi.yaml` → `components.schemas.User`

### Change
Add `email_verified` boolean property to the User schema.

```yaml
# Add after "email" property:
email_verified:
  type: boolean
  description: Whether the user's email has been verified by an OAuth provider
```

**Notes**:
- NOT added to `required` array — field may be absent for backwards compatibility with clients that don't expect it yet.
- The field will always be populated in the database (NOT NULL DEFAULT 0), but the API response treats it as optional.

## oauthCallback Response: No Schema Changes

The callback response already returns a `User` object and an optional `pending_link`. The `email_verified` field will be included automatically once added to the User schema. No structural changes to the callback response shape.

## PendingLink Schema: No Changes

The PendingLink schema remains unchanged. The email verification gate is application-layer logic only.

## SDD Commit Order

Per Constitution Principle I:
1. **Commit 1**: Update `schemas/openapi.yaml` (add `email_verified` to User)
2. **Commit 2**: Run `npm run generate`, commit `src/types/generated.ts`
3. **Commit 3**: Add DB migration SQL
4. **Commit 4**: Implement callback logic using generated types
