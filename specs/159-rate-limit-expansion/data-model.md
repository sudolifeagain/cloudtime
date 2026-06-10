# Data Model: Rate limiting beyond the OAuth endpoints

**Branch**: `159-rate-limit-expansion` | **Date**: 2026-06-10

**No persisted data changes** — no D1/KV writes are added; rejected requests
do strictly less storage work than today.

## Rate-limiter namespaces (configuration-only)

| Binding | Namespace | Limit | Period | Key | Guards |
|---|---|---|---|---|---|
| `RATE_LIMIT_OAUTH_INITIATE` (existing) | 1001 | 10 | 60 s | truncated IP | `GET /auth/{provider}` |
| `RATE_LIMIT_OAUTH_CALLBACK` (existing) | 1002 | 5 | 60 s | truncated IP | `GET /auth/{provider}/callback` |
| `RATE_LIMIT_LINK_VERIFY` (new) | 1003 | 5 | 60 s | truncated IP | `GET /auth/link/verify/{token}` |
| `RATE_LIMIT_PUBLIC_STATS` (new) | 1004 | 30 | 60 s | truncated IP | `GET /stats/{range}` |

Key truncation: /24 for IPv4, /48 for IPv6 (`src/middleware/rate-limit.ts`,
unchanged). Counters are per edge location per key (platform semantics,
research header). Namespace ids continue the account-unique sequence.

## Evaluation order (contract)

- Verify route: `405 method check → limiter → INSTANCE_MODE check → token
  format check (#152) → D1` (research D-2).
- Stats route: `PUBLIC_STATS disabled gate (#156, 404) → limiter → range
  validation → KV cache → D1` (research D-3).
