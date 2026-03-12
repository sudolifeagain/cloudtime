# Quickstart: Timezone-Aware Summary Bucketing

## What This Feature Does

Makes authenticated API endpoints default the `timezone` query parameter to the user's profile timezone instead of UTC. This ensures that queries like "Today" and "Yesterday" align with the user's local calendar date without requiring clients to explicitly pass `?timezone=Asia/Tokyo` on every request.

## Prerequisites

- Existing user with a non-UTC timezone set (e.g., `PATCH /api/v1/users/current/profile` with `{"timezone": "Asia/Tokyo"}`)
- Heartbeats ingested that span a UTC day boundary

## Quick Verification

1. Set user timezone:
   ```bash
   curl -X PATCH https://your-instance/api/v1/users/current/profile \
     -H "Authorization: Basic $(echo -n ':your-api-key' | base64)" \
     -H "Content-Type: application/json" \
     -d '{"timezone": "Asia/Tokyo"}'
   ```

2. Query summaries WITHOUT timezone parameter:
   ```bash
   curl https://your-instance/api/v1/users/current/summaries?range=Today \
     -H "Authorization: Basic $(echo -n ':your-api-key' | base64)"
   ```

3. **Expected**: Returns summary for "today" in Asia/Tokyo (JST), not UTC.

4. Query global stats (unauthenticated) — should still use UTC:
   ```bash
   curl https://your-instance/api/v1/stats/last_7_days
   ```

5. **Expected**: Date range anchored to UTC (unchanged behavior).

## Key Files Changed

| File | Change |
|------|--------|
| `schemas/paths/summaries/summaries.yaml` | Updated timezone param description |
| `schemas/paths/stats/stats.yaml` | Updated timezone param description |
| `schemas/paths/stats/status-bar.yaml` | Updated timezone param description |
| `schemas/paths/stats/durations.yaml` | Updated timezone param description |
| `schemas/paths/meta/global-stats.yaml` | Added limitation documentation |
| `src/types/generated.ts` | Regenerated (no manual edits) |
| `src/middleware/auth.ts` | Exposes `userTimezone` in context |
| `src/routes/summaries.ts` | Defaults tz to `c.get("userTimezone")` |
| `src/routes/stats.ts` | Defaults tz to `c.get("userTimezone")` |
| `docs/timezone-behavior.md` | New: documents TZ behavior and limitations |
