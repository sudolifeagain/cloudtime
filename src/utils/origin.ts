/**
 * Shared CORS / CSRF origin matching logic.
 *
 * Used by both the global CORS middleware and auth-route CSRF middleware
 * to avoid duplicating the same origin callback.
 */

/**
 * Returns the allowed origin string for CORS / CSRF validation.
 * - If APP_URL is set, only that origin is accepted (returns "" on mismatch).
 * - If APP_URL is unset (dev), all origins are reflected back (allow-all).
 */
export function matchOrigin(origin: string, appUrl?: string): string {
  if (appUrl) {
    const normalized = appUrl.replace(/\/+$/, "");
    return origin === normalized ? origin : "";
  }
  // Development: reflect origin (allow all)
  return origin;
}
