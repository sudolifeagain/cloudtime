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
  SESSION_SECRET: string;
  ENCRYPTION_KEY: string;

  // Instance mode: "single" (default) or "multi" (future)
  INSTANCE_MODE?: string;

  // Runtime environment (set via wrangler.toml [vars] or secret)
  ENVIRONMENT?: string;
}

// Hono environment with authenticated user context
export type AuthEnv = {
  Bindings: Env;
  Variables: { userId: string };
};

// Hono environment for session-authenticated routes
export type SessionAuthEnv = {
  Bindings: Env;
  Variables: { userId: string; sessionId: string; sessionTokenHash: string };
};

// NOTE: For API request/response types, use generated types from
// src/types/generated.ts (produced by `npm run generate`).
// This file is only for Cloudflare bindings and other manual types.
