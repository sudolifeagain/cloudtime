# OpenAPI Schema Diff

This feature changes only **description text** in the OpenAPI schema. No new fields, response codes, or schema shapes are introduced. The 429 response and `Retry-After` header are already declared on both OAuth paths.

## Files touched

1. `schemas/components/responses/TooManyRequests.yaml`
2. `schemas/paths/auth/provider.yaml`
3. `schemas/paths/auth/provider-callback.yaml`

## Diff 1 — `TooManyRequests.yaml`

Change the lead-in description from "Recommended" to "Enforced", and split out the OAuth limits as concrete numbers tied to this feature.

```diff
-description: |
-  Rate limit exceeded. Recommended limits:
-  - OAuth start/callback: 10 req/min per IP
-  - API key regeneration: 3 req/min per user
-  - Account linking: 5 req/min per user
-  - Session management: 30 req/min per user
-  Implementation: Use Cloudflare Workers native Rate Limiting binding.
+description: |
+  Rate limit exceeded. Limits enforced by this implementation:
+  - OAuth initiate (`GET /auth/:provider`): 10 req/min per IP (truncated /24 for IPv4, /48 for IPv6)
+  - OAuth callback (`GET /auth/:provider/callback`): 5 req/min per IP (same key derivation)
+
+  Other endpoints listed in earlier drafts (API key regeneration, account linking,
+  session management) are NOT yet rate-limited at the edge; they retain their
+  application-level controls (e.g., 3 active pending links per user).
+
+  Implementation: Cloudflare Workers native Rate Limiting binding.
```

## Diff 2 — `provider.yaml`

No structural change. The `429` response continues to `$ref` `TooManyRequests.yaml`. The diff is captured in `TooManyRequests.yaml` above. If a separate, path-specific clarification is desired, the future-form would attach a `description` override at the `429:` key, but per simplicity-first this is omitted unless reviewers request it.

## Diff 3 — `provider-callback.yaml`

Same as Diff 2 — no structural change. Description text lives in the shared component.

## Generated-types impact

`npm run generate` regenerates `src/types/generated.ts` from `schemas/openapi.yaml`. Because the changes are description-only, the generated TypeScript types should be byte-identical or contain only JSDoc comment changes. **The diff for `src/types/generated.ts` will be reviewed in PR1 and must not contain any type-shape changes** — if it does, the schema diff has unintended side-effects and the PR is blocked until the schema change is narrowed.

## SDD compliance note

Per CLAUDE.md: *"`schemas/openapi.yaml` is the Single Source of Truth"* and *"Always update the spec BEFORE writing implementation code."*

This PR1 lands the schema and SpecKit artifacts. PR2 (separate) wires the middleware and `wrangler.toml` binding. No implementation code is included in PR1.
