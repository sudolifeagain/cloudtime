# Cloudflare Platform Constraints & Mitigation

## D1 (Database)

### Limits
| Resource | Free | Paid ($5/mo) |
|----------|------|-------------|
| Row reads | 5M / day | 50B / month |
| Row writes | 100K / day | 50B / month |
| Storage | 5 GB | 50 GB |
| Max result size | 1 MB per query | 1 MB per query |
| Max bound parameters | 100 per query | 100 per query |

### Concern: Heartbeat Write Volume
IDE plugins send heartbeats on every keystroke (with deduplication). A single developer can generate hundreds of heartbeats per hour. The free tier's 100K writes/day is sufficient for single-user, but must be monitored.

### Mitigation: Batch Insert Strategy
```
Plugin sends bulk heartbeats (up to 25 per request)
    │
    ▼
Worker receives POST /heartbeats.bulk
    │
    ├── Validate all heartbeats
    ├── Single D1 batch INSERT (1 write operation, not 25)
    └── Return results
```

D1 supports batch operations via `db.batch()` which executes multiple statements in a single transaction. This reduces 25 individual writes to 1 batch write.

### Future Mitigation: KV Write Buffer
If write volume becomes an issue:
```
Heartbeat → KV (temp buffer, keyed by user:timestamp)
    │
    ▼ (Cron every 1 min or Durable Object alarm)
    │
    ▼
Flush KV buffer → D1 batch INSERT
```

This trades real-time consistency for write efficiency. Status bar endpoint can read from KV buffer + D1 for up-to-date results.

## Workers (Compute)

### Limits
| Resource | Free | Paid |
|----------|------|------|
| CPU time per request | 10 ms | 30 s |
| Request duration | N/A | 15 min (Cron) |
| Memory | 128 MB | 128 MB |
| Subrequests | 50 per request | 1000 per request |

### Concern: Cron Aggregation Timeout
The hourly Cron job aggregates raw heartbeats into summaries. As data grows, a single aggregation pass may exceed CPU limits.

### Mitigation: Chunked Aggregation

**Phase 1 (current): Simple aggregation**
```sql
-- Aggregate only heartbeats since last aggregation
INSERT INTO summaries (...)
SELECT user_id, date(time, 'unixepoch'), project, language, ...
FROM heartbeats
WHERE time > :last_aggregated_at
GROUP BY user_id, date, project, language, ...
ON CONFLICT (...) DO UPDATE SET total_seconds = total_seconds + excluded.total_seconds;
```
Track `last_aggregated_at` in KV. Process only new data each run.

**Phase 2 (if needed): Time-windowed chunks**
```
Cron fires every hour
    │
    ├── Read last_aggregated_at from KV
    ├── Process at most 1 hour of heartbeats per run
    ├── If behind, process oldest chunk first
    ├── Update last_aggregated_at
    └── If more chunks remain, set flag for next run
```

**Phase 3 (if needed): Cloudflare Queues**
```
Cron fires → Publish aggregation jobs to Queue
    │
    ▼
Queue consumer (separate Worker)
    ├── Process one chunk per message
    ├── Automatic retry on failure
    └── Parallel processing of independent chunks
```

Queues are paid-only ($0.40/million messages) but provide reliable async processing with retries.

## KV (Cache)

### Limits
| Resource | Free | Paid |
|----------|------|------|
| Reads | 100K / day | Unlimited |
| Writes | 1K / day | Unlimited |
| Storage | 1 GB | Unlimited |
| Value size | 25 MB | 25 MB |

### Current Usage
- API key → user_id resolution (read-heavy, 1h TTL)
- Session validation
- Status bar cache

### Concern: KV Write Limit on Free Tier
1K writes/day is tight if using KV as a heartbeat buffer.

### Mitigation
- On free tier: Skip KV buffer, write directly to D1
- On paid tier: Enable KV buffer for better performance
- Status bar cache: Update only on heartbeat write (not a separate write)

## Summary of Strategy by Tier

| Strategy | Free Tier | Paid Tier |
|----------|-----------|-----------|
| Heartbeat writes | D1 batch insert directly | KV buffer → D1 batch flush |
| Aggregation | Simple incremental (Cron) | Chunked + Queues if needed |
| Caching | KV for auth + status bar | KV for auth + status bar + heartbeat buffer |
| CPU budget | Keep per-request under 10ms | 30s budget, more room |

## Implementation Notes

- Start with the simplest approach (direct D1 batch insert, simple Cron aggregation)
- Add complexity only when hitting actual limits
- Monitor D1 usage via Wrangler dashboard: `wrangler d1 info cloudtime-db`
- Log aggregation timing in Cron handler to detect approaching limits early
