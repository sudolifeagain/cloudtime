/**
 * Shared helpers for auth route handlers.
 */
import type { Env } from "../../types";

export function getRedirectUri(c: { req: { url: string }; env: Env }, provider: string, isLink = false): string {
  let origin = c.env.APP_URL?.replace(/\/+$/, "");
  if (!origin) {
    if (c.env.ENVIRONMENT === "development") {
      origin = new URL(c.req.url).origin;
    } else {
      throw new Error("APP_URL environment variable is required in production");
    }
  }
  return isLink
    ? `${origin}/api/v1/auth/link/${provider}/callback`
    : `${origin}/api/v1/auth/${provider}/callback`;
}

export function securityHeaders(): Record<string, string> {
  return {
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  };
}
