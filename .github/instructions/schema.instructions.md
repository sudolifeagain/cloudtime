---
applyTo: "schemas/**/*.yaml"
---
# OpenAPI Schema Standards

- This file is the Single Source of Truth. Changes here drive all implementation.
- Every endpoint must have `operationId`, `tags`, `summary`, and complete `responses`.
- Required fields must be listed in the `required` array.
- Use `$ref` for reusable schemas in `components/schemas`.
- Use proper `format` annotations: `date`, `date-time`, `uri`, `email`, `double`.
- Error responses must use the shared `Unauthorized` / `NotFound` response refs.
- Public endpoints must explicitly set `security: []`.
