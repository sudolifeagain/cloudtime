# cloudtime

Self-hosted, WakaTime-compatible coding time tracker on Cloudflare Workers + D1.

## Architecture

- **Runtime:** Cloudflare Workers (V8 isolates, no Node.js APIs)
- **Framework:** Hono
- **Database:** Cloudflare D1 (SQLite)
- **Cache:** Cloudflare KV
- **Auth:** OAuth 2.0 (GitHub/Google/Discord) + API key for editor plugins
- **Schema:** OpenAPI 3.1 at `schemas/openapi.yaml` (Single Source of Truth)

## SDD Rules

- `schemas/openapi.yaml` defines all API contracts. Code must match the schema.
- TypeScript types in `src/types/generated.ts` are auto-generated. Never edit manually.
- DB schema in `src/db/schema.sql` must align with OpenAPI models.

## Code Standards

- Use `async/await`, never raw Promise chains
- Validate all external input at route boundaries
- Return proper HTTP status codes matching the OpenAPI spec
- Use generated types from `src/types/generated.ts` for request/response typing
- Bind secrets via `Env` interface, never hardcode credentials
- Use Web Crypto API for all cryptography (no Node.js `crypto`)

## Security

- Session tokens stored as SHA-256 hash, never plaintext
- OAuth tokens encrypted with AES-256-GCM at rest
- Cookies: `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` prefix in production
- OAuth flows use PKCE + state parameter
- Never expose API keys in responses except on creation/regeneration

## Legal

- Never use "WakaTime" in code identifiers, file names, or branding
- "WakaTime-compatible" is allowed only in documentation descriptions
