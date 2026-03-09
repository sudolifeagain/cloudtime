---
applyTo: "schemas/**/*.yaml"
---
# OpenAPI Schema Standards (Multi-file)

## Structure
- `schemas/openapi.yaml` is the entry point. It contains `$ref` pointers to path files and security schemes.
- `schemas/paths/<domain>/<endpoint>.yaml` — one file per endpoint, grouped by domain subdirectory.
- `schemas/components/schemas/<Model>.yaml` — one file per data model.
- `schemas/components/responses/<Response>.yaml` — shared error responses.

## Editing rules
- Every endpoint must have `operationId`, `tags`, `summary`, and complete `responses`.
- Required fields must be listed in the `required` array.
- Use `$ref` to reference component schemas (relative path: `../../components/schemas/Foo.yaml`).
- Use proper `format` annotations: `date`, `date-time`, `uri`, `email`, `double`.
- Error responses must use the shared `Unauthorized` / `NotFound` response refs.
- Public endpoints must explicitly set `security: []`.

## Cross-file consistency
- When reviewing a path file, verify that referenced `$ref` targets in `components/schemas/` exist and match.
- Field names in request/response schemas must align with `src/db/schema.sql` column names.
- After changes, the schema must pass `npm run lint:api` (Redocly lint).

## Tooling pipeline
- `npm run bundle` — Redocly bundles multi-file schema into `schemas/_bundled/openapi.yaml`.
- `npm run generate` — Bundle + generate TypeScript types to `src/types/generated.ts`.
- `npm run lint:api` — Lint the schema with Redocly rules defined in `redocly.yaml`.
