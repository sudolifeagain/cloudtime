/**
 * Email verification helpers for OAuth callback flows.
 *
 * These functions are called by the OAuth callback handler to:
 * - Set email_verified on new user creation (FR-002)
 * - Upgrade email_verified on existing user login — high-water mark (FR-003)
 * - Gate PendingLink creation on dual email verification (FR-004/005/006)
 *
 * The email_verified field uses a high-water mark approach:
 * once set to true, it is never downgraded back to false.
 */

import type { Env } from "../types";

/**
 * Build the SQL column list and values for inserting a new user,
 * including the email_verified field.
 *
 * Called during OAuth callback path c: new email → new user.
 * (FR-002)
 *
 * @param providerEmailVerified - Whether the OAuth provider reported the email as verified
 * @returns The integer value (0 or 1) to use in the INSERT for email_verified
 */
export function getEmailVerifiedForInsert(
  providerEmailVerified: boolean,
): number {
  return providerEmailVerified ? 1 : 0;
}

/**
 * Upgrade email_verified to true if the provider reports verified.
 * Uses high-water mark: never downgrades from true to false.
 *
 * Called during OAuth callback path a: oauth_account exists → login.
 * (FR-003)
 *
 * @param db - D1 database binding
 * @param userId - The existing user's ID
 * @param providerEmailVerified - Whether the provider reports the email as verified
 */
export async function upgradeEmailVerified(
  db: D1Database,
  userId: string,
  providerEmailVerified: boolean,
): Promise<void> {
  if (!providerEmailVerified) {
    // High-water mark: do not downgrade. Skip update.
    return;
  }
  // Only upgrade: SET email_verified = 1 WHERE currently 0
  await db
    .prepare(
      "UPDATE users SET email_verified = 1 WHERE id = ? AND email_verified = 0",
    )
    .bind(userId)
    .run();
}

/**
 * Check whether a PendingLink should be created during same-email detection.
 * Both the existing user's email AND the incoming provider's email must be verified.
 *
 * Called during OAuth callback path b: no oauth_account + email matches existing user.
 * (FR-004, FR-005, FR-006)
 *
 * In single-user mode, this function is NOT called — the provider is linked directly.
 * (FR-007)
 *
 * @param db - D1 database binding
 * @param email - The email address to match
 * @param providerEmailVerified - Whether the incoming provider reports the email as verified
 * @returns The existing user to link to, or null if PendingLink should NOT be created
 */
export async function findVerifiedUserForPendingLink(
  db: D1Database,
  email: string,
  providerEmailVerified: boolean,
): Promise<{ id: string; email_verified: number } | null> {
  // FR-005: incoming provider must report verified
  if (!providerEmailVerified) {
    return null;
  }

  // FR-004: existing user's email must be verified
  // Use ORDER BY created_at ASC LIMIT 1 for deterministic selection if duplicates exist
  const existingUser = await db
    .prepare(
      "SELECT id, email_verified FROM users WHERE email = ? ORDER BY created_at ASC LIMIT 1",
    )
    .bind(email)
    .first<{ id: string; email_verified: number }>();

  if (!existingUser) {
    return null;
  }

  // FR-004: check existing user's email_verified
  if (existingUser.email_verified !== 1) {
    return null; // FR-006: fall through to new user creation
  }

  return existingUser;
}
