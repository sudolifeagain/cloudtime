/**
 * Test fixtures that seed the in-memory D1 used by vitest-pool-workers.
 * Helpers mint deterministic users with API keys / session tokens so
 * integration tests can authenticate without going through OAuth.
 */
import { env } from "cloudflare:test";
import { generateApiKey, generateSessionToken, sha256Hex } from "../../src/utils/crypto";

export interface SeededUser {
  userId: string;
  username: string;
  apiKey: string;
  apiKeyHash: string;
}

export interface SeededSession extends SeededUser {
  sessionToken: string;
  sessionTokenHash: string;
}

/**
 * Insert a fresh user row with a generated API key and return both the
 * plaintext key (for use in Authorization headers) and the user_id.
 */
export async function seedUser(
  overrides: Partial<{
    username: string;
    email: string | null;
    timezone: string;
    emailVerified: boolean;
  }> = {},
): Promise<SeededUser> {
  const userId = crypto.randomUUID();
  const username = overrides.username ?? `testuser_${userId.slice(0, 8)}`;
  const { plaintext: apiKey, hash: apiKeyHash } = await generateApiKey();

  await env.DB.prepare(
    `INSERT INTO users (id, username, email, email_verified, timezone, api_key_hash, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  )
    .bind(
      userId,
      username,
      overrides.email ?? `${username}@example.test`,
      overrides.emailVerified === false ? 0 : 1,
      overrides.timezone ?? "UTC",
      apiKeyHash,
    )
    .run();

  return { userId, username, apiKey, apiKeyHash };
}

/**
 * Seed a user and create an active session for them. Used by tests that
 * exercise session-cookie protected routes.
 */
export async function seedUserWithSession(
  overrides?: Parameters<typeof seedUser>[0],
): Promise<SeededSession> {
  const user = await seedUser(overrides);
  const sessionToken = generateSessionToken();
  const sessionTokenHash = await sha256Hex(sessionToken);

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_active_at)
     VALUES (?, ?, ?, datetime('now'), datetime('now', '+7 days'), datetime('now'))`,
  )
    .bind(crypto.randomUUID(), user.userId, sessionTokenHash)
    .run();

  return { ...user, sessionToken, sessionTokenHash };
}

/**
 * Reset all rows from the listed tables. Useful between tests that share
 * state. vitest-pool-workers isolates storage per test file, but within a
 * file you may want to start fresh between cases.
 */
export async function truncate(...tables: string[]): Promise<void> {
  for (const table of tables) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}
