import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirrors the [define] block in wrangler.toml; without it /api/v1/meta
  // throws a ReferenceError (500) inside the test workers pool.
  define: {
    __APP_VERSION__: JSON.stringify("0.0.0-test"),
  },
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2025-03-09",
        d1Databases: ["DB"],
        kvNamespaces: ["KV"],
        r2Buckets: ["R2_BUCKET"],
        bindings: {
          INSTANCE_MODE: "single",
          GITHUB_CLIENT_ID: "test-github-client-id",
          GITHUB_CLIENT_SECRET: "test-github-client-secret",
          GOOGLE_CLIENT_ID: "test-google-client-id",
          GOOGLE_CLIENT_SECRET: "test-google-client-secret",
          DISCORD_CLIENT_ID: "test-discord-client-id",
          DISCORD_CLIENT_SECRET: "test-discord-client-secret",
          ENCRYPTION_KEY:
            "0000000000000000000000000000000000000000000000000000000000000000",
          APP_URL: "https://test.cloudtime.dev",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./tests/setup.ts"],
    // Agent worktrees under .claude/worktrees/ contain a full repo copy;
    // without this exclude vitest discovers their tests too and runs the
    // whole suite twice (against potentially stale sources).
    exclude: ["**/node_modules/**", "**/.claude/**"],
  },
});
