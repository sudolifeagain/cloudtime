# Contract: Heartbeat Bulk Response

## POST /api/v1/users/current/heartbeats.bulk

### Request Body

Array of HeartbeatInput objects (max 25).

### Response (202)

```json
{
  "responses": [
    [{"data": {"id": "uuid-1"}, "error": null}, 201],
    [{"data": {"id": "uuid-2"}, "error": null}, 201],
    [{"data": null, "error": "Missing required field: entity"}, 400]
  ]
}
```

### Tuple Structure

Each item in `responses` is a 2-element array:

| Index | Type | Description |
|-------|------|-------------|
| 0 | HeartbeatBulkItem | `{data: {id: string} \| null, error: string \| null}` |
| 1 | integer | HTTP status code for this individual heartbeat |

### Per-Item Status Codes

| Code | Meaning |
|------|---------|
| 201 | Heartbeat created successfully |
| 400 | Validation error (invalid type, category, missing fields) |

### Validation

- Request with >25 items → entire request rejected with 400
- Each heartbeat validated independently; valid ones succeed even if others fail
