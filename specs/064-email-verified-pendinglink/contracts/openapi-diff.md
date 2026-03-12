# OpenAPI Contract Change: email_verified on User

**Date**: 2026-03-13 | **Branch**: `064-email-verified-pendinglink`

## Change

Add `email_verified` boolean field to the `User` schema component in `schemas/openapi.yaml`.

## Affected Endpoints

All endpoints that return a User object:

| Endpoint | Method | Response field |
|----------|--------|---------------|
| `/auth/{provider}/callback` | GET | `data.user.email_verified` |
| `/auth/link/approve/{pending_link_id}` | POST | `data.user.email_verified` |
| `/auth/session` | GET | `data.user.email_verified` |

## Schema Diff

```yaml
# In components.schemas.User.properties, add:
email_verified:
  type: boolean
  description: Whether the user's email address has been verified through a trusted source.
  example: true

# Add to required list if User has one, otherwise it has a default (false)
```

## Compatibility

- **Additive change**: New field added to existing response. Existing clients that don't read `email_verified` are unaffected.
- **No breaking changes**: No fields removed, renamed, or type-changed.
