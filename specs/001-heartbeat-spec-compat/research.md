# Research: Heartbeat Spec WakaTime-compatible CLI Compatibility

## R1: Bulk Response Format

**Decision**: Use `[HeartbeatBulkItem, code]` tuple where `HeartbeatBulkItem = {data: {id: string} | null, error: string | null}`.

**Rationale**: WakaTime-compatible CLI clients parse bulk responses by extracting `data.id` from each item. The current `[Heartbeat, code]` format returns the full heartbeat object, which the CLI does not expect. Returning only `{id}` in `data` minimizes payload size while satisfying CLI parsing.

**Alternatives considered**:
- Return full Heartbeat object inside `data` — larger payload, CLI ignores extra fields anyway.
- Return flat `{id, error, code}` — breaks the tuple structure CLI expects.

## R2: Dependencies Format Normalization

**Decision**: Accept both `string[]` and comma-separated `string`. Normalize string to array by splitting on commas and trimming whitespace.

**Rationale**: Older WakaTime-compatible CLI versions and some plugins may send comma-separated strings. Accepting both formats ensures backward compatibility without data loss. DB column is TEXT, storing JSON-serialized arrays regardless of input format.

**Alternatives considered**:
- Strict `string[]` only — risks breaking older clients.
- Store as-is without normalization — inconsistent data format in DB.

## R3: `end` Timestamp Derivation

**Decision**: Compute `end` at query time using the next heartbeat's `time` within the same session. If the gap exceeds 15 minutes (timeout threshold), `end = start`.

**Rationale**: This matches WakaTime-compatible behavior (as implemented by Wakapi). Heartbeats within a 15-minute window are considered part of the same coding session. Computing at query time avoids extra storage and stays consistent as new heartbeats arrive.

**Alternatives considered**:
- Store `end` in DB — extra write cost, stale when new heartbeats fill gaps.
- Fixed duration addition — inaccurate, doesn't reflect actual coding sessions.

## R4: Header Fallback for machine/user_agent

**Decision**: Body fields take priority over headers. `X-Machine-Name` header → `machine` fallback. `User-Agent` header → `user_agent` fallback.

**Rationale**: The body is the explicit, intentional value from the CLI client. The header may be set by HTTP libraries or proxies. Body-wins ensures the CLI's intended value is stored.

**Alternatives considered**:
- Header-wins — risks overwriting intentional CLI values with proxy User-Agent strings.
- No header fallback — some minimal plugins only set headers, not body fields.

## R5: OpenAPI Spec Structure for New Schemas

**Decision**: Create separate component files for `HeartbeatBulkItem.yaml`, `MachineNameHeader.yaml`, `UserAgentHeader.yaml`. Expand existing `Category.yaml` and `HeartbeatInput.yaml` inline.

**Rationale**: Follows existing project convention where each schema/parameter is a separate YAML file under `schemas/components/`. Keeps individual files small and reviewable per SDD principles.

**Alternatives considered**:
- Inline everything in path files — violates existing project convention, harder to review.
