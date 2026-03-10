# Contract: HeartbeatInput

## POST /api/v1/users/current/heartbeats

### Request Headers

| Header | Required | Description |
|--------|----------|-------------|
| X-Machine-Name | no | Fallback for `machine` field if not in body |
| User-Agent | no | Fallback for `user_agent` field if not in body |

### Request Body

```json
{
  "entity": "/path/to/file.ts",
  "type": "file",
  "time": 1710100000.000,
  "category": "coding",
  "project": "cloudtime",
  "branch": "develop",
  "language": "TypeScript",
  "dependencies": ["react", "lodash"],
  "lines": 150,
  "lineno": 42,
  "cursorpos": 10,
  "is_write": true,
  "editor": "VS Code",
  "operating_system": "Linux",
  "machine": "my-laptop",
  "user_agent": "wakatime/v1.90.0"
}
```

### Field Priority

- `machine`: body field > `X-Machine-Name` header > null
- `user_agent`: body field > `User-Agent` header > null

### user_agent → user_agent_id Resolution

The input field `user_agent` (raw string) is resolved to `user_agent_id` (stored/response) via the `user_agents` table:
1. Receive `user_agent` string from body or `User-Agent` header
2. Look up or create a row in `user_agents` table matching the string
3. Store the `user_agents.id` in `heartbeats.user_agent_id`
4. The response schema exposes `user_agent_id`, not the raw string

### Dependencies Normalization

| Input | Stored Value |
|-------|-------------|
| `["react", "lodash"]` | `["react","lodash"]` |
| `"react, lodash"` | `["react","lodash"]` |
| `"react"` | `["react"]` |
| `null` / absent | `null` |

### Response (201)

```json
{
  "data": {
    "id": "uuid-here",
    "entity": "/path/to/file.ts",
    "type": "file",
    "time": 1710100000.000,
    "user_id": "user-uuid",
    "machine": "my-laptop",
    "created_at": "2026-03-11T00:00:00Z"
  }
}
```

### Validation Errors (400)

- Unknown `type` value
- Unknown `category` value
- Missing required fields (`entity`, `type`, `time`)
