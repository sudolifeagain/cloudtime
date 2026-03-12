# Quickstart: Verify Existing User Email Before Creating PendingLink

**Branch**: `064-email-verified-pendinglink`

## Prerequisites

- Node.js, npm installed
- Cloudflare Wrangler CLI configured
- Access to D1 database (local or remote)

## Implementation Order (SDD workflow)

### PR1: Spec + Schema

1. **Update OpenAPI spec** — Add `email_verified` to User schema in `schemas/openapi.yaml`
2. **Regenerate types** — `npm run generate`
3. **Update DB schema** — Add `email_verified` column to `users` in `src/db/schema.sql`
4. **Write migration** — Create migration SQL for existing databases

### PR2: Implementation

5. **Update user utility** — Add `email_verified` to `UserRow` type and `rowToUser()` in `src/utils/user.ts`
6. **Modify login flow** — In `src/routes/auth/login.ts`:
   - Fetch `email_verified` in email match query
   - If unverified: clear existing user's email, fall through to new user creation
   - Set `email_verified = 1` when creating new user with verified email
7. **Modify link approval** — In `src/routes/auth/link.ts`:
   - Set `email_verified = 1` on existing user when PendingLink is approved with verified provider email
8. **Type check** — `npx tsc --noEmit`

## Verification

```bash
# Type check
npx tsc --noEmit

# Local dev server
npx wrangler dev

# Run migration on local D1
npx wrangler d1 execute cloudtime-db --local --file=migrations/XXXX_add_email_verified.sql
```

## Key Files

| File | Change |
|------|--------|
| `schemas/openapi.yaml` | Add `email_verified` to User schema |
| `src/types/generated.ts` | Regenerated (not hand-edited) |
| `src/db/schema.sql` | Add column to CREATE TABLE |
| `src/routes/auth/login.ts` | Gate PendingLink + set on creation |
| `src/routes/auth/link.ts` | Set on PendingLink approval |
| `src/utils/user.ts` | Add to UserRow + rowToUser |
