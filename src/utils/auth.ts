import type { HonoRequest } from "hono";
import type { Env } from "../types";

/**
 * Extract API key from request (WakaTime-compatible auth)
 * Supports: Basic Auth (base64 encoded api_key), Bearer token, query param
 */
export function getApiKey(req: HonoRequest): string | null {
  const authHeader = req.header("Authorization");

  if (authHeader?.startsWith("Basic ")) {
    try {
      const decoded = atob(authHeader.slice(6));
      // WakaTime sends "api_key:" as basic auth
      const colonIdx = decoded.indexOf(":");
      return colonIdx >= 0 ? decoded.slice(0, colonIdx) : decoded;
    } catch {
      return null;
    }
  }

  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  return req.query("api_key") ?? null;
}

/**
 * SHA-256 hash a string and return hex-encoded result.
 */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Resolve user_id from API key (uses KV cache)
 * Hashes the plaintext key with SHA-256 before querying api_key_hash column.
 * KV cache key uses the hash (never stores plaintext keys).
 */
export async function getUserId(
  apiKey: string,
  env: Env,
): Promise<string | null> {
  const keyHash = await sha256Hex(apiKey);

  // Check KV cache first (keyed by hash)
  const cached = await env.KV.get(`apikey:${keyHash}`);
  if (cached) return cached;

  // Fallback to D1
  const row = await env.DB.prepare("SELECT id FROM users WHERE api_key_hash = ?")
    .bind(keyHash)
    .first<{ id: string }>();

  if (row) {
    await env.KV.put(`apikey:${keyHash}`, row.id, { expirationTtl: 3600 });
  }

  return row?.id ?? null;
}
