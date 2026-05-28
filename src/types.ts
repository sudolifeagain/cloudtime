// Cloudflare Workers bindings
export interface Env {
  DB: D1Database;
  KV: KVNamespace;

  // OAuth providers (set via `wrangler secret put`)
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;

  // Security
  ENCRYPTION_KEY: string;

  // Instance mode: "single" (default) or "multi" (future)
  INSTANCE_MODE?: string;

  // Optional raw-heartbeat retention window in days (Issue #108). Unset or
  // non-positive = retain forever. When set, the hourly cron purges raw
  // heartbeats older than this many days; pre-aggregated `summaries` are
  // unaffected.
  HEARTBEAT_RETENTION_DAYS?: string;

  // Runtime environment (set via wrangler.toml [vars] or secret)
  ENVIRONMENT?: string;

  // Public origin for OAuth redirect URIs (e.g., "https://time.example.com")
  // If unset, derived from request Host header (safe behind Cloudflare, risky with custom proxies)
  APP_URL?: string;

  // Optional Google Workspace hosted domain restriction. When set, the
  // authorization URL includes `hd=<domain>` as a UX hint and the callback
  // enforces the matching `hd` claim on the validated id_token. Tokens with
  // no `hd` claim (personal Google accounts) or a non-matching `hd` are
  // rejected with 403. See specs/037-google-hosted-domain/.
  GOOGLE_HOSTED_DOMAIN?: string;

  // Rate-limit bindings (optional — middleware fails open when undefined)
  RATE_LIMIT_OAUTH_INITIATE?: RateLimit;
  RATE_LIMIT_OAUTH_CALLBACK?: RateLimit;

  // Email delivery (Issue #80). Required in multi-user mode for the
  // out-of-band PendingLink verification flow. Single-user mode does not
  // create PendingLinks and therefore does not send email.
  EMAIL_PROVIDER?: string; // currently supports "resend"
  EMAIL_FROM?: string; // e.g. "noreply@cloudtime.example.com"
  RESEND_API_KEY?: string;
}

// Minimal shape of Cloudflare Workers Rate Limiting binding. The official
// `@cloudflare/workers-types` v4 does not export this name yet (still under
// the unsafe namespace at compatibility_date 2025-03-09), so we declare the
// surface we actually call.
export interface RateLimit {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

// Hono environment with authenticated user context
export type AuthEnv = {
  Bindings: Env;
  Variables: {
    userId: string;
    userTimezone?: string;
    // users.timeout in MINUTES (matches the DB column). Cron aggregator and
    // heartbeat handlers convert to seconds at the comparison site.
    userTimeout?: number;
  };
};

// Hono environment for session-authenticated routes
export type SessionAuthEnv = {
  Bindings: Env;
  Variables: { userId: string; sessionId: string; sessionTokenHash: string };
};

// NOTE: For API request/response types, use generated types from
// src/types/generated.ts (produced by `npm run generate`).
// This file is only for Cloudflare bindings and other manual types.
