# OpenAPI Contract Changes: Timezone Default Behavior

## Summary

Update `timezone` query parameter descriptions on authenticated endpoints to reflect the new default behavior (user's profile timezone instead of UTC).

## Affected Endpoints

### 1. `GET /api/v1/users/current/summaries`
**File**: `schemas/paths/summaries/summaries.yaml`
**Change**: Update `timezone` parameter description.
```yaml
- name: timezone
  in: query
  description: >-
    IANA timezone (e.g. Asia/Tokyo). Shifts the date anchor used for range
    resolution. Defaults to the authenticated user's profile timezone when
    omitted.
  schema:
    type: string
```

### 2. `GET /api/v1/users/current/stats/:range`
**File**: `schemas/paths/stats/stats.yaml`
**Change**: Update `timezone` parameter description.
```yaml
- name: timezone
  in: query
  description: >-
    IANA timezone (e.g. Asia/Tokyo). Shifts the date anchor used for range
    resolution. Defaults to the authenticated user's profile timezone when
    omitted.
  schema:
    type: string
```

### 3. `GET /api/v1/users/current/status_bar/today`
**File**: `schemas/paths/stats/status-bar.yaml`
**Change**: Update `timezone` parameter description.
```yaml
- name: timezone
  in: query
  description: >-
    IANA timezone (e.g. Asia/Tokyo). Determines what "today" means.
    Defaults to the authenticated user's profile timezone when omitted.
  schema:
    type: string
```

### 4. `GET /api/v1/users/current/durations`
**File**: `schemas/paths/stats/durations.yaml`
**Change**: Update `timezone` parameter description.
```yaml
- name: timezone
  in: query
  description: >-
    IANA timezone (e.g. Asia/Tokyo). Determines epoch boundaries for the
    given date. Defaults to the authenticated user's profile timezone when
    omitted.
  schema:
    type: string
```

### 5. `GET /api/v1/stats/:range` (Global Stats — No Default Change)
**File**: `schemas/paths/meta/global-stats.yaml`
**Change**: Add clarification note only. Default remains UTC.
```yaml
- name: timezone
  in: query
  description: >-
    IANA timezone (e.g. Asia/Tokyo). Shifts the date anchor used for range
    resolution. Defaults to UTC when omitted. Note: summary data is bucketed
    by each user's profile timezone. In single-user mode, the query timezone
    and bucketing timezone align when the user's profile timezone matches.
    Cross-user timezone aggregation is a known limitation for future
    multi-user support.
  schema:
    type: string
```

## Unchanged Endpoints

- `GET /api/v1/users/current/external_durations` — accepts `timezone` but is not yet implemented. Will inherit the pattern when implemented.
- All heartbeat endpoints — no timezone parameter.
- Auth endpoints — no timezone parameter.
