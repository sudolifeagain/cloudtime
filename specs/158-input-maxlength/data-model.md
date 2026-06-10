# Data Model: Maximum lengths on write-input fields

**Branch**: `158-input-maxlength` | **Date**: 2026-06-10

**No persisted data changes**: no new tables, columns, KV keys, or
migrations. The feature constrains four existing request schemas; D1 columns
remain TEXT (SQLite has no enforced VARCHAR width — the validators are the
enforcement point).

## Constrained request schemas (contract-level)

| Schema | Field | Cap (inclusive, UTF-16 code units) |
|---|---|---|
| HeartbeatInput | entity | 4096 |
| | project / branch / language / editor / operating_system / machine | 255 |
| | user_agent | 512 |
| | dependencies (string) | 8192 |
| | dependencies (array) | maxItems 100; items 255 |
| CommitInput | hash | 64 |
| | message | 4096 |
| | author_name / committer_name | 255 |
| | author_email / committer_email | 254 |
| | ref | 255 |
| | url | 2048 |
| ExternalDurationInput | external_id | 255 |
| | entity | 4096 |
| | project / branch / language | 255 |
| | meta | 8192 |
| CustomRuleInput | source_value / destination_value | 1024 |

## Ambient (header-derived) values — truncated, not rejected

| Source | Cap | Applied at |
|---|---|---|
| `User-Agent` header → `user_agents.value` | 512 | `resolveUserAgentId` (PR2) |
| `X-Machine-Name` header → `machine_names.value` / `heartbeats.machine` | 255 | heartbeat ingestion (PR2) |

Pre-existing rows that exceed a cap (if any) are untouched (research R-7).
