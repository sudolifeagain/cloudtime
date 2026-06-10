# Quickstart: validating write-input maximum lengths

**Branch**: `158-input-maxlength` | **Scope**: PR2 behavior (PR1 ships contract only)

## Prerequisites

- `npm install`, local D1 initialized (`npm run db:init`), an API key
  (or run the automated tests, which mint one via fixtures)

## Scenario 1 — oversized body field rejected (User Story 1)

```bash
# entity over 4096 chars → 400, nothing stored
python - <<'EOF'
print('{"entity":"%s","type":"file","time":1750000000}' % ("x"*5000))
EOF
# POST that JSON to /api/v1/users/current/heartbeats with your API key
```

**Expected**: the endpoint's standard `400` validation error naming
`entity`; no heartbeat row written. Bulk requests report the oversized item
per-item while valid siblings persist.

## Scenario 2 — boundary value accepted (User Story 2)

A heartbeat whose `entity` is exactly 4096 characters (or `project` exactly
255) is accepted — caps are inclusive. The entire pre-existing test corpus
passes unmodified.

## Scenario 3 — ambient headers truncate (User Story 3)

Send a heartbeat with a >512-character `User-Agent` header (no body
`user_agent`): the heartbeat succeeds and `GET /api/v1/users/current/user_agents`
shows the value truncated to 512. Same for a >255-character `X-Machine-Name`
header → `machine_names` value truncated to 255. Oversized **body**
`user_agent`/`machine` fields are rejected per Scenario 1.

## Automated validation (PR2)

- `tests/security/input-limits.test.ts` — constants pinned to the documented
  values (FR-007) + helper behavior
- validator unit tests — cap / cap+1 boundaries per schema, dependencies
  string/array forms
- `tests/integration/heartbeats.test.ts` — oversized single + bulk per-item
  400 shapes; header-truncation acceptance

```bash
npm run typecheck && npm test
```

Contract: [contracts/openapi-diff.md](./contracts/openapi-diff.md) · values:
[data-model.md](./data-model.md) · decisions: [research.md](./research.md)
