# OpenAPI Schema Diff

## Files touched

1. **New**: `schemas/components/responses/Gone.yaml`
2. **New**: `schemas/paths/auth/link-verify-token.yaml`
3. **Modified**: `schemas/openapi.yaml` — wire the new path
4. **Modified**: `schemas/paths/auth/link-approve.yaml` — declare the 403 response (existing `Forbidden.yaml` reused)

## Diff 1 — new `Gone.yaml`

Shared 410 component for the verify endpoint's "token expired / already used / not found" responses.

```yaml
description: |
  The resource exists but is no longer available. Used by single-use
  verification flows where the token has been consumed, expired, or
  never existed.
content:
  application/json:
    schema:
      type: object
      properties:
        error:
          type: string
          example: Token expired
```

## Diff 2 — new `link-verify-token.yaml`

```yaml
get:
  operationId: verifyLinkEmailToken
  tags:
    - auth
  summary: Out-of-band email verification for PendingLink
  description: |
    Verifies the recipient's inbox access for an outstanding PendingLink.
    The token is single-use and embedded in a one-time email sent at
    PendingLink creation.

    On first successful hit within the token's TTL, the server marks the
    underlying PendingLink row as email-verified. Subsequent hits, hits
    against an expired row, and hits against an unknown token all return
    410 Gone. The endpoint is public (no auth) because the recipient may
    not have a CloudTime session in the browser used to open the email.

    The state change occurs on GET because the token itself is the proof
    of authorisation; this is acceptable for single-use tokens and is
    intentionally compatible with mobile email clients that pre-fetch
    links (pre-fetch consumes the token; user clicks then see 410 — this
    behaviour is documented in the operator runbook).
  security: []
  parameters:
    - name: token
      in: path
      required: true
      schema:
        type: string
      description: |
        32-byte base64url-encoded one-time token. Plaintext appears only
        in the email body; only the SHA-256 hash is persisted server-side.
  responses:
    '200':
      description: Verification succeeded. Recipient should return to CloudTime to approve the merge.
      content:
        text/html:
          schema:
            type: string
          example: |
            <!doctype html><h1>Email verified</h1>
            <p>Return to CloudTime and approve the account merge.</p>
    '405':
      description: Method Not Allowed — verify endpoint only accepts GET.
    '410':
      $ref: ../../components/responses/Gone.yaml
```

## Diff 3 — `schemas/openapi.yaml`

Add the new path under `paths:`. Insertion point sits next to the existing `link-approve` and `link-provider-callback` paths.

```diff
   /auth/link/approve/{pending_link_id}:
     $ref: ./paths/auth/link-approve.yaml
+  /auth/link/verify/{token}:
+    $ref: ./paths/auth/link-verify-token.yaml
   /auth/link/{provider}/callback:
     $ref: ./paths/auth/link-provider-callback.yaml
```

## Diff 4 — `link-approve.yaml`

Add the 403 response (reusing the existing `Forbidden.yaml` component introduced for the Google hosted-domain feature). The status semantics are now twofold ("registration closed" was already a possible 403 in the broader auth area; this adds "email verification required").

```diff
   responses:
     '200':
       $ref: ../../components/responses/Success.yaml   # or whatever is current
+    '403':
+      $ref: ../../components/responses/Forbidden.yaml
     '404':
       $ref: ../../components/responses/NotFound.yaml
```

The body shape under `Forbidden.yaml` already includes a generic `error: string`. The specific reason `"Email verification required"` is emitted at runtime; documenting all possible 403 reasons in the component would bloat the schema. The component description already enumerates major scenarios.

## Generated-types impact

`npm run generate` should produce additive changes only:
- New `Gone` response component → new exported component type.
- New `verifyLinkEmailToken` operation → new entry under `operations`.
- 403 response added to `oauthLinkApprove` → operation type gains a `403` key.

No existing exported types are renamed or removed.

## SDD compliance note

Per CLAUDE.md: *"`schemas/openapi.yaml` is the Single Source of Truth"* and *"Always update the spec BEFORE writing implementation code."*

PR1 lands SpecKit artifacts, schema, migration SQL, and generated types. PR2 lands implementation. No runtime code in PR1.
