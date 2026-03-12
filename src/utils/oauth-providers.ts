/**
 * Normalize email_verified from OAuth provider responses.
 *
 * Each provider returns email verification status under a different field name:
 * - GitHub: `verified` on each email object from GET /user/emails
 * - Google (OIDC): `email_verified` (boolean)
 * - Google (v2): `verified_email` (boolean)
 * - Google (ID Token): `email_verified` as string "true"/"false"
 * - Discord: `verified` (boolean, absent without `email` scope)
 */

export type OAuthProvider = "github" | "google" | "discord";

/** GitHub email object from GET /user/emails */
interface GitHubEmail {
  email: string;
  verified: boolean;
  primary: boolean;
  visibility: string | null;
}

/**
 * Extract email_verified from a GitHub /user/emails response.
 * Returns the primary email's verified status.
 * If no primary verified email is found, returns { email: null, verified: false }.
 */
export function extractGitHubEmailVerified(
  emails: GitHubEmail[],
): { email: string | null; verified: boolean } {
  const primary = emails.find((e) => e.primary);
  if (primary) {
    return { email: primary.email, verified: primary.verified === true };
  }
  // Fallback: first verified email if no primary
  const firstVerified = emails.find((e) => e.verified);
  if (firstVerified) {
    return { email: firstVerified.email, verified: true };
  }
  return { email: emails[0]?.email ?? null, verified: false };
}

/**
 * Extract email_verified from a Google userinfo response.
 * Handles both OIDC (`email_verified`) and v2 (`verified_email`) field names,
 * as well as string "true"/"false" from ID tokens.
 */
export function extractGoogleEmailVerified(
  userInfo: Record<string, unknown>,
): boolean {
  // OIDC endpoint: email_verified (boolean or string)
  const oidcValue = userInfo.email_verified;
  if (oidcValue !== undefined) {
    return oidcValue === true || oidcValue === "true";
  }
  // v2 endpoint: verified_email (boolean)
  const v2Value = userInfo.verified_email;
  if (v2Value !== undefined) {
    return v2Value === true || v2Value === "true";
  }
  return false;
}

/**
 * Extract email_verified from a Discord /users/@me response.
 * The `verified` field is absent (not false) without the `email` scope.
 */
export function extractDiscordEmailVerified(
  userInfo: Record<string, unknown>,
): boolean {
  const value = userInfo.verified;
  if (value === undefined || value === null) {
    return false;
  }
  return value === true;
}

/**
 * Unified extractor: normalize email_verified for any supported provider.
 * Returns false if the provider does not report verification status.
 */
export function extractEmailVerified(
  provider: OAuthProvider,
  providerData: Record<string, unknown>,
): boolean {
  switch (provider) {
    case "github":
      // For GitHub, providerData should contain an `emails` array
      // from the GET /user/emails endpoint
      if (Array.isArray(providerData.emails)) {
        return extractGitHubEmailVerified(
          providerData.emails as GitHubEmail[],
        ).verified;
      }
      return false;
    case "google":
      return extractGoogleEmailVerified(providerData);
    case "discord":
      return extractDiscordEmailVerified(providerData);
    default:
      return false;
  }
}
