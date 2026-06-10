/// <reference path="../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />

declare module "*.sql?raw" {
  const content: string;
  export default content;
}

// Augment the global Cloudflare.Env (from @cloudflare/workers-types) with the
// project's actual bindings so `import { env } from "cloudflare:test"` /
// `cloudflare:workers` are typed correctly inside tests.
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      KV: KVNamespace;
      R2_BUCKET?: R2Bucket;
      GITHUB_CLIENT_ID: string;
      GITHUB_CLIENT_SECRET: string;
      GOOGLE_CLIENT_ID: string;
      GOOGLE_CLIENT_SECRET: string;
      DISCORD_CLIENT_ID: string;
      DISCORD_CLIENT_SECRET: string;
      ENCRYPTION_KEY: string;
      INSTANCE_MODE?: string;
      PUBLIC_STATS?: string;
      ALLOWED_OWNER_EMAIL?: string;
      ENVIRONMENT?: string;
      APP_URL?: string;
      GOOGLE_HOSTED_DOMAIN?: string;
      RATE_LIMIT_OAUTH_INITIATE?: import("../src/types").RateLimit;
      RATE_LIMIT_OAUTH_CALLBACK?: import("../src/types").RateLimit;
    }
  }
}

export {};
