# Data Model: Out-of-Band Email Verification

## Existing schema (relevant fragment)

```sql
CREATE TABLE IF NOT EXISTS pending_links (
  id TEXT PRIMARY KEY,
  existing_user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  provider_username TEXT,
  provider_email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  access_token_encrypted TEXT,
  refresh_token_encrypted TEXT,
  token_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  ...
);
```

The existing `email_verified` column tracks the **OAuth provider's** verification claim and is set at row creation. It is NOT what gates approval after this feature.

## Additions

```sql
ALTER TABLE pending_links ADD COLUMN email_verification_token_hash TEXT;
ALTER TABLE pending_links ADD COLUMN email_verified_at TEXT;

CREATE INDEX IF NOT EXISTS idx_pending_links_token_hash
  ON pending_links(email_verification_token_hash);
```

### Column semantics

| Column | Type | Nullable | Set when | Read by |
|---|---|---|---|---|
| `email_verification_token_hash` | TEXT | Yes (legacy rows / single-user mode) | At PendingLink INSERT, SHA-256 of the URL token | Verify endpoint lookup |
| `email_verified_at` | TEXT (SQL datetime string) | Yes | When verify endpoint successfully consumes the token | Approve endpoint gate; replay detection |

### Distinction from existing fields

- `email_verified` (existing) — claim from the OAuth provider; **boolean**, set on row creation. Used in the dual-verification gate that decides whether to create a PendingLink at all.
- `email_verified_at` (new) — proof that the human recipient clicked the link from their inbox; **timestamp**, set lazily after the email round-trip. Used as the final gate before approve succeeds.

### Index rationale

The verify endpoint performs a single point lookup on the hash:

```sql
UPDATE pending_links
SET email_verified_at = datetime('now')
WHERE email_verification_token_hash = ?
  AND email_verified_at IS NULL
  AND expires_at > datetime('now')
RETURNING id
```

Without the index the lookup is O(n) over all open PendingLinks. Volume is small (3 active per user), but the index is cheap and aligns with project precedent (`idx_pending_links_expires`).

## Migration

```sql
-- migrations/0002_pending_link_email_verification.sql
ALTER TABLE pending_links ADD COLUMN email_verification_token_hash TEXT;
ALTER TABLE pending_links ADD COLUMN email_verified_at TEXT;
CREATE INDEX IF NOT EXISTS idx_pending_links_token_hash
  ON pending_links(email_verification_token_hash);
```

### Backfill policy

**No backfill.** Pre-existing rows have `email_verified_at IS NULL` and therefore cannot be approved once this feature is live. Documented impact:

- The window is bounded by `pending_links.expires_at` (≤ 1 hour by default).
- Users with a pending row at deploy time receive a 403 on approve. They can recover by re-triggering OAuth login (which produces a new row + new verification email under the new flow).
- This is acceptable because PendingLinks are short-lived and the worst-case is "user repeats login once."

If desired in the future, an operator-initiated migration could optionally fill `email_verified_at` for legacy rows treating them as grandfathered, but the security posture argues against it.

### Schema.sql synchronisation

`src/db/schema.sql` is updated alongside the migration so fresh deployments via `npm run db:init` include the new columns and index without applying the migration file. This mirrors how `0001_add_email_verified.sql` is handled today.

## Cleanup

No new cleanup job. The existing cron purge

```sql
DELETE FROM pending_links WHERE expires_at < datetime('now')
```

removes rows whose tokens have therefore also expired. No orphan token state survives row deletion.

## Tests touching the schema

`tests/setup.ts` loads `src/db/schema.sql` via `?raw` import. Once schema.sql is updated, the existing setup pipeline picks up the new columns with no test-side changes.

A fixture helper (added in PR2) will seed PendingLink rows with known token hashes so integration tests can assert verify/approve transitions without going through the full OAuth flow.
