# OpenAPI Schema Diff

This feature changes only **description text** in the OpenAPI schema. No new fields, response codes, or schema shapes are introduced. The 429 response and `Retry-After` header are already declared on both OAuth paths.

## Files touched

1. `schemas/components/responses/TooManyRequests.yaml`
2. `schemas/paths/auth/provider.yaml`
3. `schemas/paths/auth/provider-callback.yaml`

## Diff 1 — `TooManyRequests.yaml`

Keep the shared 429 response generic because several non-OAuth-initiate/callback endpoints also reference it. Endpoint-specific OAuth limits are documented on the affected operations instead.

```diff
-description: |
-  Rate limit exceeded. Recommended limits:
-  - OAuth start/callback: 10 req/min per IP
-  - API key regeneration: 3 req/min per user
-  - Account linking: 5 req/min per user
-  - Session management: 30 req/min per user
-  Implementation: Use Cloudflare Workers native Rate Limiting binding.
+description: |
+  Rate limit exceeded. The exact threshold depends on the endpoint.
+  OAuth login endpoints enforce Cloudflare Workers native Rate Limiting
+  bindings, keyed by truncated client IP. Authenticated endpoints may use
+  separate application-level controls, such as pending-link limits.
+
+  See the operation description for endpoint-specific limits.
```

## Diff 2 — `provider.yaml`

No structural change. The `429` response continues to `$ref` `TooManyRequests.yaml`. The operation description adds: OAuth initiate is limited to 10 requests per configured 60-second Cloudflare Rate Limiting window, keyed by client IP truncated to /24 for IPv4 or /48 for IPv6.

## Diff 3 — `provider-callback.yaml`

No structural change. The `429` response continues to `$ref` `TooManyRequests.yaml`. The operation description adds: OAuth callback is limited to 5 requests per configured 60-second Cloudflare Rate Limiting window, keyed by client IP truncated to /24 for IPv4 or /48 for IPv6, and enforced before state validation or provider token exchange.

## Generated-types impact

`npm run generate` regenerates `src/types/generated.ts` from `schemas/openapi.yaml`. Because the changes are description-only, the generated TypeScript types should be byte-identical or contain only JSDoc comment changes. **The diff for `src/types/generated.ts` will be reviewed in PR1 and must not contain any type-shape changes** — if it does, the schema diff has unintended side-effects and the PR is blocked until the schema change is narrowed.

## SDD compliance note

Per CLAUDE.md: *"`schemas/openapi.yaml` is the Single Source of Truth"* and *"Always update the spec BEFORE writing implementation code."*

This PR1 lands the schema and SpecKit artifacts. PR2 (separate) wires the middleware and `wrangler.toml` binding. No implementation code is included in PR1.
