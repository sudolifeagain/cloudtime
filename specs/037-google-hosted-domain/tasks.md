# Tasks: Optional Google Hosted Domain Restriction

**Branch**: `037-google-hosted-domain`
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Generated**: 2026-05-17

## PR1 — Spec + Design

- [x] **T-001**: Author `spec.md` covering FR-001 through FR-008, NFRs, and success criteria.
- [x] **T-002**: Author `plan.md` with Constitution Check, code-change sketch.
- [x] **T-003**: Author `research.md` documenting `hd` claim semantics, case sensitivity, fail-closed default.
- [x] **T-004**: Author `quickstart.md` with scenarios A–F.
- [x] **T-005**: Author `contracts/openapi-diff.md` summarizing schema changes.
- [x] **T-006**: Author `checklists/requirements.md` (acceptance gates for PR1, PR2, and post-deploy).
- [ ] **T-007**: Update `schemas/paths/auth/provider-callback.yaml` — add `'403'` response for domain mismatch.
- [ ] **T-008**: Update `schemas/paths/auth/provider.yaml` — mention `GOOGLE_HOSTED_DOMAIN` in operation description (one line).
- [ ] **T-009**: Run `npm run generate` and verify `src/types/generated.ts` diff is description-only / type-shape additive (new 403 response type is acceptable).
- [ ] **T-010**: Commit PR1 (`spec:` prefix), push, open PR against `develop`.

## PR2 — Implementation (after PR1 merges)

### Type changes

- [ ] **T-101**: Add `GOOGLE_HOSTED_DOMAIN?: string;` to `Env` in `src/types.ts`.

### Source changes (single file: `src/utils/oauth.ts`)

- [ ] **T-102**: In `buildAuthorizeUrl` Google branch, after `nonce` line, append:
  ```ts
  if (env.GOOGLE_HOSTED_DOMAIN) url.searchParams.set("hd", env.GOOGLE_HOSTED_DOMAIN);
  ```
- [ ] **T-103**: Add `class HostedDomainError extends Error` at module scope (or near `validateGoogleIdToken`). Export it so the callback handler can `instanceof` against it.
- [ ] **T-104**: In `validateGoogleIdToken`, after the `at_hash` block and before reading `payload.sub`, insert:
  ```ts
  const requiredHd = env.GOOGLE_HOSTED_DOMAIN?.trim().toLowerCase();
  if (requiredHd) {
    const tokenHd = typeof payload.hd === "string" ? payload.hd.trim().toLowerCase() : "";
    if (tokenHd !== requiredHd) {
      const reason = tokenHd ? "hd-mismatch" : "hd-missing";
      console.warn(`[google-hosted-domain] rejected rule=google-hosted-domain reason=${reason} expected=${requiredHd}`);
      throw new HostedDomainError("Google account domain not allowed");
    }
  }
  ```

### Callback handler change (`src/routes/auth/login.ts`)

- [ ] **T-105**: In the outer `try/catch` of `GET /:provider/callback`, before the generic `Internal server error` branch, add:
  ```ts
  if (err instanceof HostedDomainError) {
    return c.json({ error: "Account domain not allowed" }, 403, noCacheHeaders());
  }
  ```

### Configuration documentation

- [ ] **T-106**: Add a comment line in `wrangler.toml` near the existing OAuth secret comments documenting the optional `GOOGLE_HOSTED_DOMAIN` variable.
- [ ] **T-107**: Update `docs/auth-design.md` (if a Google section exists) with a brief paragraph describing the restriction. If no suitable doc exists, link to the spec from `docs/cloudflare-constraints.md`.

### Verification

- [ ] **T-108**: `npx tsc --noEmit` — zero errors.
- [ ] **T-109**: Manually verify scenarios A–E from `quickstart.md` on a staging Worker (or document why staging is unavailable).
- [ ] **T-110**: Verify the GitHub and Discord callback paths produce byte-identical responses to pre-feature behavior (no accidental cross-provider impact).

### PR2 submission

- [ ] **T-111**: Commit with `feat:` prefix. Push, open PR against `develop` referencing #37 and PR1.

## Dependencies

```
T-001 … T-009 → T-010 (PR1 merge)
T-010 → T-101 … T-111
T-101 → T-104 (Env type must exist before code reads env.GOOGLE_HOSTED_DOMAIN)
T-103 → T-104 → T-105 (error class → throw site → catch site)
T-104 → T-108 (compile check after main change)
```

## Out of scope (do not implement in this feature)

- Multi-domain support (`GOOGLE_HOSTED_DOMAINS` plural).
- GitHub/Discord equivalent restrictions.
- Database-backed user allowlist.
- Migration utilities for users who become locked out after domain change.
