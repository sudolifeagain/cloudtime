# OpenAPI Schema Diff

This feature adds one shared response component (`Forbidden`), references it from the Google callback path, and adds a single description line to the Google initiate path. No other path is touched.

## Files touched

1. `schemas/components/responses/Forbidden.yaml` — **new** shared 403 response component.
2. `schemas/paths/auth/provider-callback.yaml` — reference the new component as `'403'`.
3. `schemas/paths/auth/provider.yaml` — one-line description addition referencing `GOOGLE_HOSTED_DOMAIN`.

## Diff 1 — new `Forbidden.yaml`

```yaml
description: |
  The authenticated principal is recognized but not authorized for this resource.
  Common reasons:
  - Single-user mode: registration closed (`/auth/:provider/callback`).
  - Google hosted domain restriction: the Google account's domain does not match
    `GOOGLE_HOSTED_DOMAIN` (`/auth/google/callback`).
content:
  application/json:
    schema:
      type: object
      properties:
        error:
          type: string
          example: Account domain not allowed
```

Mirrors the shape of the existing `Unauthorized.yaml` / `BadRequest.yaml` components.

## Diff 2 — `provider-callback.yaml`

Add the `403` response to the existing `responses:` block. No other change.

```diff
   responses:
     '200':
       description: Authentication successful
       …
     '400':
       $ref: ../../components/responses/BadRequest.yaml
+    '403':
+      $ref: ../../components/responses/Forbidden.yaml
     '429':
       $ref: ../../components/responses/TooManyRequests.yaml
```

(Note: a 403 was already returned by `src/routes/auth/login.ts` for single-user mode "Registration closed" but was not documented. This PR makes the existing-and-new behavior contract-true.)

## Diff 3 — `provider.yaml`

One-line addition in the operation `description` block, between the existing scope notes and the security-measures list. No structural change.

```diff
   description: |
     Redirects the user to the OAuth provider's authorization page.

+    **Optional per-deployment restrictions:**
+    - Google: if the operator sets `GOOGLE_HOSTED_DOMAIN`, the authorization URL
+      includes `hd=<domain>` as a UX hint and the callback enforces the matching
+      `hd` claim on the validated id_token. Tokens with no `hd` claim (personal
+      Google accounts) or a non-matching `hd` are rejected with 403.

     **Security measures applied by the server:**
     - …
```

## Generated-types impact

`npm run generate` regenerates `src/types/generated.ts`. Two changes are expected:

1. A new exported component type for the `Forbidden` response (additive, no break).
2. The `oauthCallback` operation gains a `403` entry under `responses` (additive, no break).

Both are additive and do not break any existing import sites.

## SDD compliance note

Per CLAUDE.md: *"`schemas/openapi.yaml` is the Single Source of Truth"* and *"Always update the spec BEFORE writing implementation code."*

PR1 lands schema + spec. PR2 lands the `Env` type extension, the two-line edit in `src/utils/oauth.ts`, and the `instanceof HostedDomainError` branch in `src/routes/auth/login.ts`. No implementation code in PR1.
