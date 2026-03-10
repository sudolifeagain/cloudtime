# Quickstart: Heartbeat Spec WakaTime-CLI Compatibility

## Prerequisites

- Node.js, npm installed
- Wrangler CLI configured
- CloudTime project cloned, on `001-heartbeat-spec-compat` branch

## SDD Workflow

### Step 1: Update OpenAPI Spec

Edit the following schema files under `schemas/`:

1. `components/schemas/Category.yaml` — add 5 enum values
2. `components/schemas/HeartbeatInput.yaml` — add `machine`, `user_agent` fields; expand `type` enum; change `dependencies` to accept string or array
3. `components/schemas/Heartbeat.yaml` — add `start`, `end`, `timezone` response fields
4. `components/schemas/HeartbeatBulkItem.yaml` — create new schema
5. `components/parameters/MachineNameHeader.yaml` — create new parameter
6. `components/parameters/UserAgentHeader.yaml` — create new parameter
7. `paths/heartbeats/heartbeats.yaml` — add header params to POST, add fields to GET response
8. `paths/heartbeats/heartbeats-bulk.yaml` — update response schema

Commit: `spec: update heartbeat schema for wakatime-cli compatibility`

### Step 2: Regenerate Types

```bash
npm run generate
```

Commit: `chore: regenerate types`

### Step 3: Update Route Handler

Edit `src/routes/heartbeats.ts`:

1. Add dependencies normalization (string → array)
2. Add machine/user_agent body field handling with header fallback
3. Update bulk response format to `[HeartbeatBulkItem, code]`
4. Add `start`, `end`, `timezone` computation to GET response

Commit: `feat: implement heartbeat wakatime-cli compatibility`

### Step 4: Validate

```bash
npx tsc --noEmit
```

### Step 5: Create PR

```bash
git push -u origin 001-heartbeat-spec-compat
gh pr create --base develop
```

## Verification

```bash
# Single heartbeat with new fields
curl -X POST http://localhost:8787/api/v1/users/current/heartbeats \
  -H "Authorization: Bearer ck_test" \
  -H "X-Machine-Name: my-laptop" \
  -d '{"entity":"/app.ts","type":"url","time":1710100000,"category":"meeting","dependencies":["react"],"machine":"my-laptop"}'

# Bulk heartbeats
curl -X POST http://localhost:8787/api/v1/users/current/heartbeats.bulk \
  -H "Authorization: Bearer ck_test" \
  -d '[{"entity":"/a.ts","type":"file","time":1710100000},{"entity":"/b.ts","type":"file","time":1710100060}]'
# Expect: {"responses":[[{"data":{"id":"..."},"error":null},201], ...]}

# GET with enriched response
curl http://localhost:8787/api/v1/users/current/heartbeats?date=2026-03-11 \
  -H "Authorization: Bearer ck_test"
# Expect: each heartbeat has start, end, timezone fields
```
