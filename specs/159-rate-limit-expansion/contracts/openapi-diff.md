# OpenAPI Contract Diff: rate limiting beyond OAuth

**Branch**: `159-rate-limit-expansion`
**Files**: `schemas/paths/auth/link-verify-token.yaml` (verify operation), `schemas/paths/meta/global-stats.yaml` (`getGlobalStats`)

Additive only: one new documented response per operation (`'429': $ref`
shared `TooManyRequests` component, exactly as the OAuth operations document
it) plus a rate-limit sentence in each description. No parameter, schema, or
existing-response changes.

## 1. link-verify-token.yaml

- Responses: add
  ```yaml
  '429':
    $ref: ../../components/responses/TooManyRequests.yaml
  ```
- Description: append one sentence —
  "Rate limited at the edge (5 requests per 60-second window per truncated
  client IP, /24 IPv4 or /48 IPv6) after the method check and before any
  token processing (#159)."

## 2. global-stats.yaml

- Responses: add
  ```yaml
  '429':
    $ref: ../../components/responses/TooManyRequests.yaml
  ```
- Description: append one sentence —
  "Rate limited at the edge (30 requests per 60-second window per truncated
  client IP); on instances with `PUBLIC_STATS=false` the disabled `404`
  takes precedence and the limiter is never consulted (#159)."

## Generated types impact

- `src/types/generated.ts`: the two operations' `responses` maps each gain a
  `429: components["responses"]["TooManyRequests"]` entry, plus updated
  description JSDoc. No existing member changes.
- Verified by `npm run generate` + reviewing the diff.
