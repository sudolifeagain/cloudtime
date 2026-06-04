# Multi-User Mode — Foundation Design

**Status**: Design (Issue #148) · **Date**: 2026-06-05
**Scope**: Foundation only — multi-user enablement, privacy/visibility model, feature-gating convention. Leaderboards (#136) and Orgs (#137) layer on top in later PRs.

This document is the design for turning `INSTANCE_MODE=multi` into a usable foundation. It complements [auth-design.md](./auth-design.md) (which already describes the OAuth modes) and does not change single-user behavior.

## 1. Starting point — already multi-user-ready

A codebase survey established that most of the hard parts are done:

- **User resolution is per-user.** API-key (`src/utils/auth.ts`) and session (`src/middleware/auth.ts`) auth both resolve a request to a `user_id` dynamically. There is no "first user" / `LIMIT 1` / hardcoded-owner shortcut anywhere.
- **Data isolation is complete.** Every user-scoped query already filters `WHERE user_id = ?`. The only intentionally cross-user read is the public global stats (`GET /stats/{range}`, `src/routes/meta.ts`).
- **Account-merge plumbing exists** and is gated on `INSTANCE_MODE=multi`: same-email → PendingLink → out-of-band email verification → approve (`src/routes/auth/login.ts`, `src/routes/auth/link.ts`).
- **Schema is in place** for later milestones: `leaderboards`, `leaderboard_members`, `organizations`, `org_members`, `org_dashboards` already exist (`src/db/schema.sql`). Their endpoints are declared in the OpenAPI spec but have **no route handlers** (#136/#137).

What is missing is purely: (a) how new users are admitted, (b) a visibility model so multi-user does not over-expose people, and (c) a gating convention so multi-only endpoints behave in single-user mode.

## 2. Decisions

| # | Decision | Choice |
|---|----------|--------|
| D-1 | Registration policy | **Invite-code gated.** A new OAuth identity may sign up only with a valid, unused invite. |
| D-2 | Default visibility | **Private by default (opt-in).** New users are not public; public profile, leaderboard appearance, and inclusion in public global stats each require an explicit opt-in. |
| D-3 | Milestone scope | **Foundation only.** Leaderboards (#136) and Orgs (#137) are deferred and layer on this. |
| D-4 | Single-user mode | **Unchanged.** All new behavior is behind `INSTANCE_MODE=multi`; single-user remains "first OAuth login = owner". |

## 3. Pillar A — Invite-code registration (D-1)

### Data model

New table (lands with the invites PR; mirror in `schema.sql` **and** a `migrations/NNNN_*.sql`):

```sql
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,     -- SHA-256 of the plaintext code (never store plaintext)
  created_by TEXT NOT NULL,           -- issuing user
  email TEXT,                         -- optional: bind the invite to one email
  expires_at TEXT,                    -- optional expiry
  used_at TEXT,                       -- NULL until consumed
  used_by TEXT,                       -- the created user, once consumed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (used_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_created_by ON invites(created_by);
```

The plaintext invite code is shown once at creation (like the API key); only its hash is stored.

### Issuing invites (owner/existing users)

A small authenticated surface (its own SpecKit feature):

- `POST /users/current/invites` → mint an invite, return the plaintext code once. Optional `email` and `expires_at` in the body.
- `GET /users/current/invites` → list the caller's invites with status (pending / used / expired). Never returns the plaintext code.
- `DELETE /users/current/invites/{id}` → revoke an unused invite.

(Whether *any* user can invite or only an owner/admin role is an open question — see §7. The simplest foundation: any existing user may invite, since the instance is invite-gated overall.)

### Consuming an invite through OAuth

The code must ride along the OAuth round trip, which is stateful via `state` in KV:

1. `GET /api/v1/auth/{provider}?invite=<code>` — the initiate handler stores the invite code (or its hash) alongside the existing PKCE/`state` entry in KV.
2. On `…/callback`, in the **multi-user new-user branch** (`src/routes/auth/login.ts:409`), before inserting the user:
   - look up the invite by `code_hash`; reject (403 "A valid invite is required") if missing, already used, expired, or `email`-bound to a different address than the verified provider email;
   - create the user and **atomically** mark the invite consumed (`used_at`, `used_by`) in the same `db.batch()` as the user/oauth_account insert, so an invite cannot be double-spent under a race.
3. Existing-account logins and the same-email PendingLink/merge flow are **unaffected** — an invite is required only when creating a brand-new user.

Single-user mode ignores invites entirely (the single-user gate already governs the one owner).

## 4. Pillar B — Opt-in visibility (D-2)

### Data model

Add visibility flags to `users` (default 0 = private). A single column suffices to start; split later if finer control is needed:

```sql
ALTER TABLE users ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;
-- (future: appears_on_leaderboard, profile fields visibility …)
```

`is_public = 0` means: not listed on any public leaderboard, no public profile, and **excluded from the public global stats aggregate**.

### Surfaced in user settings

Extend the existing user update (`PATCH /users/current`, `src/routes/users.ts`) to accept `is_public` (boolean). No new endpoint. The `User` response schema gains an additive `is_public` field.

### Public global stats becomes opt-in-scoped

`GET /stats/{range}` (public, `security: []`, `src/routes/meta.ts`) currently aggregates **all** `summaries`. In multi-user mode this would expose every user's activity. Change: when `INSTANCE_MODE=multi`, the aggregate joins `users` and includes only `is_public = 1` users:

```sql
-- multi-user: only opted-in users contribute to the public aggregate
… FROM summaries s JOIN users u ON u.id = s.user_id WHERE u.is_public = 1 AND <range> …
```

In single-user mode the query is unchanged (the lone owner is the only contributor; no privacy concern). This keeps the endpoint cacheable (the cache key already ignores the caller).

## 5. Pillar C — Feature gating (D-3)

Multi-only endpoints (leaderboards #136, orgs #137) need a uniform behavior in single-user mode. Provide a reusable guard rather than ad-hoc checks:

```ts
// returns 404 when the instance is not in multi-user mode
export const requireMultiUser = createMiddleware<AuthEnv>(async (c, next) => {
  if (c.env.INSTANCE_MODE !== "multi") {
    return c.json({ error: "Not found" }, 404);
  }
  await next();
});
```

- Mount it on the leaderboards/orgs routers when those land, so single-user instances return a clean 404 (matching today's "routes don't exist → 404" behavior, but explicit and testable).
- The **public** leaderboard (`GET /leaders`) and **public** global stats are the only cross-user reads; both honor §4 visibility.

This pillar is a tiny helper now; its value is that #136/#137 consume it instead of re-checking `INSTANCE_MODE` per route.

## 6. Phased implementation plan

Each pillar is its own SpecKit 2-PR feature (spec PR1 → impl PR2), landing on `develop`. Order minimizes risk:

1. **Visibility model** (Pillar B) — `users.is_public`, `PATCH /users/current` field, global-stats opt-in filter, `requireMultiUser` helper (Pillar C ships here as it is tiny). Self-contained; no auth-flow change.
2. **Invite registration** (Pillar A) — `invites` table + owner endpoints + OAuth `state` plumbing + consume-on-signup. Depends on nothing but is the riskiest (touches the auth callback), so it goes second once visibility is in.
3. **Enable + document** — flip the operator story in `docs/` (how to run multi-user: set `INSTANCE_MODE=multi`, configure `EMAIL_PROVIDER`, mint the first invite). The very first user is still the single-user-style owner created before switching to multi, or bootstrapped via a one-off invite/seed (see §7).

After the foundation: **#136 Leaderboards** (consumes visibility + gating), then **#137 Orgs** (consumes gating + roles already in `org_members`).

Every schema change ships in **both** `src/db/schema.sql` and a numbered `migrations/NNNN_*.sql`. Every OpenAPI change follows the SpecKit 2-PR split. Tests: `tsc` + vitest stay green; new endpoints get integration tests.

## 7. Open questions

- **Bootstrapping the first multi-user instance**: who issues the first invite? Options: (a) start in single-user mode, the owner self-registers, then switch to `multi` and the owner mints invites; (b) an operator seed/`wrangler d1 execute` that inserts the first invite. Lean (a) — zero new surface.
- **Who may invite**: any existing user vs an owner/admin role. The schema has no global role yet (`org_members.role` is org-scoped). Simplest foundation: any user may invite; revisit if abuse matters.
- **Invite-to-email binding**: optional `email` on an invite (enforced against the verified provider email) vs open invites. Keep it optional.
- **Visibility granularity**: a single `is_public` now vs separate flags for profile / leaderboard / global-stats later. Start with one; split additively.
- **Username collisions** across many users: today usernames are UUID-suffixed (`base_<8hex>`) to dodge the UNIQUE race — fine at scale, but public profiles may want a friendlier handle (future).

## 8. Non-goals

- Leaderboards (#136), Orgs / Team dashboards (#137) — implemented after this foundation.
- Org/global RBAC beyond what `org_members.role` already implies.
- Any change to single-user mode, the heartbeat/aggregation pipeline, or existing authenticated endpoints'' data scoping.
