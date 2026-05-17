# Research: Optional Google Hosted Domain Restriction

## Decision 1: `hd` claim on the `id_token` is the security gate

**Decision**: Server-side verification of the `hd` claim on the **validated** `id_token` is the only authoritative restriction. The `hd` query parameter on the authorization URL is treated as a UX hint only.

**Rationale**:
- The `hd` query parameter is consumed by Google's authorization page as a default selection. A user can manually edit the URL or start authorization from another entry point, so it cannot be relied on for access control.
- The `hd` claim in the `id_token` is signed by Google's keys (RS256). After our existing JWT signature verification (`verifyGoogleJwt` via `jose`), the claim is trustworthy. We add the check after signature/iss/aud/azp/nonce/at_hash, never before.
- For Workspace accounts, Google emits `hd: <primary domain>` in the `id_token`. For personal accounts, the `hd` claim is absent. Absence ≠ error; absence simply means "not a Workspace account."

**Alternatives considered**:
1. **Trust the `hd` query param**: rejected — trivially forgeable.
2. **Validate the user's email domain instead of `hd`**: rejected — email domain can be aliased; `hd` is the canonical Workspace identifier and is what Google's own documentation recommends.

---

## Decision 2: Case-insensitive comparison, ASCII only

**Decision**: Compare both sides with `toLowerCase()` on plain ASCII strings.

**Rationale**:
- DNS domains are case-insensitive by RFC 1035 §2.3.3. Google's `hd` claim is always lowercase, but allowing the operator to set `GOOGLE_HOSTED_DOMAIN=Company.COM` is operator-friendly.
- `toLowerCase()` is locale-sensitive in theory (Turkish dotless I edge case) but harmless for ASCII-only domain strings. We do not perform any locale-sensitive normalization.
- Internationalized Domain Names (IDN, e.g., `xn--bcher-kva.example`) are out of scope. Google Workspace customers using IDN are exceptionally rare; if encountered, the operator can configure the punycode form.

**Alternatives considered**:
1. **Strict case-sensitive comparison**: rejected — operator-hostile (`GOOGLE_HOSTED_DOMAIN=Company.com` failing silently is exactly the kind of trap we should avoid).
2. **Full Unicode-aware normalization**: rejected — adds dependency and complexity for a non-existent customer cohort.

---

## Decision 3: Missing `hd` claim ⇒ 403 (fail closed)

**Decision**: When `GOOGLE_HOSTED_DOMAIN` is set, a token with no `hd` claim (personal account) is treated as a domain mismatch and rejected with 403.

**Rationale**:
- The operator's intent in setting the env var is "only organization accounts." Personal Google accounts (no `hd` claim) are not organization accounts.
- Fail-closed is the correct default for security restrictions.
- The rejection reason distinguishes `hd-missing` vs `hd-mismatch` in logs so operators can see whether attempted abuse comes from personal accounts vs different Workspace domains.

**Alternatives considered**:
1. **Allow tokens with no `hd` claim**: rejected — defeats the purpose of the restriction.
2. **Treat as 400 (client error)**: rejected — 403 is the standard response for "valid request, but principal not authorized." 400 implies a malformed request.

---

## Decision 4: Throw a dedicated error class, handle in the callback

**Decision**: Introduce `class HostedDomainError extends Error` module-locally in `src/utils/oauth.ts`. The existing `try/catch` in `src/routes/auth/login.ts` adds an `instanceof HostedDomainError` branch returning 403.

**Rationale**:
- Keeps `validateGoogleIdToken` returning a uniform `ProviderUserInfo` or throwing — matches current style.
- Avoids polluting `ProviderUserInfo` with a "rejected by policy" sentinel.
- The catch site (`login.ts` callback) is the right layer to translate domain rejection into an HTTP response, alongside the existing OAuth-error / email-not-verified branches.

**Alternatives considered**:
1. **Return a sentinel value from `validateGoogleIdToken`**: rejected — pollutes return type.
2. **Return early from the callback before calling `validateGoogleIdToken`**: rejected — we cannot inspect `hd` before signature verification, which lives inside `validateGoogleIdToken`.

---

## Decision 5: Place the check after all existing claim validation

**Decision**: The `hd` check runs after `iss`, `aud`, `azp`, `nonce`, and `at_hash` validation, immediately before the `sub` read.

**Rationale**:
- Signature verification must complete first or the `hd` value isn't trustworthy.
- Other claim validations are cheap and provide better attack signal: if any of those fail, the attacker is doing more sophisticated abuse than a domain bypass.
- Putting `hd` last keeps the security ordering: structural validity → cryptographic validity → identity claims → authorization claims.

**Alternatives considered**:
1. **Run `hd` check first**: rejected — incorrect ordering (cannot trust unsigned claims).
2. **Run between signature and `nonce`**: rejected — `nonce` mismatch is more critical (token replay) and should fail before policy checks.

---

## Decision 6: OpenAPI gains a `403` response on the callback path only

**Decision**: Add `'403'` to `schemas/paths/auth/provider-callback.yaml`. The initiate path (`provider.yaml`) does not gain a 403 (the env var only changes the redirect URL, no rejection happens at initiate).

**Rationale**:
- 403 is only ever returned from the callback after `id_token` validation. The initiate endpoint cannot know the user's domain yet.
- Single-user mode already returns 403 for "Registration closed" in `src/routes/auth/login.ts` — but that 403 is not currently documented in the OpenAPI schema for the callback path. Adding the response now covers both reasons (single-user closed + domain mismatch) cleanly.

**Alternatives considered**:
1. **Reuse 400 with a discriminator field**: rejected — 403 is semantically correct.

---

## Decision 7: Configuration via Worker var/secret, no `wrangler.toml` `[vars]` default

**Decision**: Document `GOOGLE_HOSTED_DOMAIN` as a Worker variable that operators set via `wrangler secret put` or by adding to their environment's `[vars]` block. Do **not** add a default in committed `wrangler.toml`.

**Rationale**:
- The value is deployment-specific. Committing a default (even commented) risks operators copying it inadvertently.
- Following the same pattern as the OAuth client IDs/secrets (documented in `wrangler.toml` as comments, set via `wrangler secret put`).

**Alternatives considered**:
1. **Add `GOOGLE_HOSTED_DOMAIN = ""` under `[vars]`**: rejected — empty string is indistinguishable from "intentionally disabled" vs "forgot to configure." Operators should set or omit, not blank.
