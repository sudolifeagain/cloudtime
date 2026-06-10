# Data Model: Instance-level opt-out for the public global stats endpoint

**Branch**: `156-public-stats-optout` | **Date**: 2026-06-10

This feature introduces **no persisted data changes**: no new tables, no new
columns, no new KV keys, no migrations.

## Configuration (not persisted)

| Name | Where | Type | Values | Default |
|------|-------|------|--------|---------|
| `PUBLIC_STATS` | Workers `[vars]` binding (`Env`, `src/types.ts`, PR2) | `string \| undefined` | trimmed, case-insensitive `"false"` ⇒ disabled; anything else ⇒ enabled | unset ⇒ enabled |

State transitions: none at runtime — Workers vars are immutable per
deployment; the value changes only via redeploy.

## Touched (unchanged) data surfaces

- **`summaries` (D1)**: read by the enabled path exactly as today; never read
  by the disabled path.
- **`global-stats:{range}` (KV, 5-min TTL)**: read/written by the enabled
  path exactly as today; never read or written by the disabled path. Entries
  written before a disable simply expire (research D-5).
