# Contract: OAuth Callback Response

## Before (current)

```
GET /:provider/callback → 200

{
  "data": {
    "user": { ... },
    "api_key": "ck_...",       ← REMOVED
    "is_new_user": true,
    "pending_link": { ... }
  }
}
```

## After (target)

```
GET /:provider/callback → 200

New user:
{
  "data": {
    "user": { ... },
    "is_new_user": true
  }
}

Existing user:
{
  "data": {
    "user": { ... },
    "is_new_user": false
  }
}

Pending link:
{
  "data": {
    "pending_link": { ... }
  }
}
```

## Changes

| Field | Before | After |
|-------|--------|-------|
| `data.api_key` | Present on new user creation (`ck_...` plaintext) | Removed entirely |
| `data.user` | Unchanged | Unchanged |
| `data.is_new_user` | Unchanged | Unchanged |
| `data.pending_link` | Unchanged | Unchanged |

## API key retrieval (existing endpoint, no changes)

```
POST /auth/api-key → 200
(requires session cookie)

{
  "data": {
    "api_key": "ck_..."
  }
}
```
