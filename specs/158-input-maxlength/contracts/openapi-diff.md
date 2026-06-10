# OpenAPI Contract Diff: write-input maximum lengths

**Branch**: `158-input-maxlength`
**Files**: `schemas/components/schemas/HeartbeatInput.yaml`, `CommitInput.yaml`, `ExternalDurationInput.yaml`, `CustomRuleInput.yaml`

This PR1 change is **additive constraint documentation**: `maxLength` /
`maxItems` keywords on existing string/array properties. No fields,
operations, status codes, or response shapes change. The exact values are
tabulated in [data-model.md](../data-model.md); the per-file edits are:

## 1. HeartbeatInput.yaml

- `entity`: `maxLength: 4096`
- `project`, `branch`, `language`, `editor`, `operating_system`, `machine`: `maxLength: 255`
- `user_agent`: `maxLength: 512`
- `dependencies` `oneOf` string branch: `maxLength: 8192`
- `dependencies` `oneOf` array branch: `maxItems: 100`, items `maxLength: 255`

## 2. CommitInput.yaml

- `hash`: `maxLength: 64` (keeps `minLength: 1`)
- `message`: `maxLength: 4096`
- `author_name`, `committer_name`: `maxLength: 255`
- `author_email`, `committer_email`: `maxLength: 254`
- `ref`: `maxLength: 255`
- `url`: `maxLength: 2048`

## 3. ExternalDurationInput.yaml

- `external_id`: `maxLength: 255`
- `entity`: `maxLength: 4096`
- `project`, `branch`, `language`: `maxLength: 255`
- `meta`: `maxLength: 8192`

## 4. CustomRuleInput.yaml

- `source_value`: `maxLength: 1024` (keeps `minLength: 1`)
- `destination_value`: `maxLength: 1024`

## Generated types impact

- `src/types/generated.ts`: openapi-typescript does not encode
  `maxLength`/`maxItems` in TypeScript types, so the expected diff is
  **empty or JSDoc-only** (description-less constraints emit nothing).
  Verified by `npm run generate` + reviewing the diff; spec↔validator value
  parity is held in PR2 by `src/utils/input-limits.ts` plus a pinning unit
  test (research R-6).
