import type { HonoRequest } from "hono";
import type { Env } from "../types";

/**
 * Extract API key from request (WakaTime-compatible auth)
 * Supports: Basic Auth (base64 encoded api_key), Bearer token, query param
 */
export function getApiKey(req: HonoRequest): string | null {
  const authHeader = req.header("Authorization");

  if (authHeader?.startsWith("Basic ")) {
    const decoded = atob(authHeader.slice(6));
    return decoded.replace(/:$/, ""); // WakaTime sends "api_key:" as basic auth
  }

  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  return req.query("api_key") ?? null;
}

/**
 * Resolve user_id from API key (uses KV cache)
 */
export async function getUserId(
  apiKey: string,
  env: Env,
): Promise<string | null> {
  // Check KV cache first
  const cached = await env.KV.get(`apikey:${apiKey}`);
  if (cached) return cached;

  // Fallback to D1
  const row = await env.DB.prepare("SELECT id FROM users WHERE api_key = ?")
    .bind(apiKey)
    .first<{ id: string }>();

  if (row) {
    await env.KV.put(`apikey:${apiKey}`, row.id, { expirationTtl: 3600 });
  }

  return row?.id ?? null;
}
