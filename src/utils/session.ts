/**
 * Session lifecycle, cookie helpers, and OAuth state KV storage.
 */
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../types";
import { normalizeDateTime, toSqliteDateTime } from "./user";

// ─── Constants ───────────────────────────────────────────

const IDLE_TIMEOUT = 24 * 60 * 60; // 24h
const ABSOLUTE_EXPIRY = 7 * 24 * 60 * 60; // 7d
const ACTIVITY_THROTTLE = 5 * 60; // 5min
const STATE_TTL = 600; // 10min
const SESSION_CACHE_TTL = 300; // 5min

// ─── Session CRUD ────────────────────────────────────────

export interface SessionData {
  userId: string;
  sessionId: string;
  expiresAt: string;
  lastActiveAt: string;
}

export async function createSession(
  db: D1Database,
  userId: string,
  tokenHash: string,
  request: Request,
): Promise<{ sessionId: string; expiresAt: string }> {
  const sessionId = crypto.randomUUID();
  const now = toSqliteDateTime();
  const expiresAt = toSqliteDateTime(new Date(Date.now() + ABSOLUTE_EXPIRY * 1000));

  const ip = request.headers.get("CF-Connecting-IP") ?? null;
  const cf = (request as Request & { cf?: { country?: string; city?: string } }).cf;
  const country = cf?.country ?? null;
  const city = cf?.city ?? null;
  const userAgent = request.headers.get("User-Agent") ?? null;

  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, token_hash, ip, country, city, user_agent, created_at, expires_at, last_active_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(sessionId, userId, tokenHash, ip, country, city, userAgent, now, expiresAt, now)
    .run();

  return { sessionId, expiresAt };
}

export async function validateSession(
  db: D1Database,
  kv: KVNamespace,
  tokenHash: string,
): Promise<SessionData | null> {
  // Check KV cache first
  const cacheKey = `session:${tokenHash}`;
  const cached = await kv.get(cacheKey);
  if (cached) {
    let data: SessionData | null = null;
    try {
      data = JSON.parse(cached) as SessionData;
    } catch {
      // Corrupted cache entry — delete and fall through to D1 lookup
      await kv.delete(cacheKey);
    }

    if (data) {
      const now = new Date();
      const expiresAt = new Date(normalizeDateTime(data.expiresAt));
      const lastActive = new Date(normalizeDateTime(data.lastActiveAt));

      // Check absolute expiry
      if (now > expiresAt) {
        await Promise.all([
          kv.delete(cacheKey),
          db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run(),
        ]);
        return null;
      }
      // Check idle timeout
      if ((now.getTime() - lastActive.getTime()) / 1000 > IDLE_TIMEOUT) {
        await Promise.all([
          kv.delete(cacheKey),
          db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run(),
        ]);
        return null;
      }

      // Throttled activity update (D1 only to reduce KV write volume)
      if ((now.getTime() - lastActive.getTime()) / 1000 > ACTIVITY_THROTTLE) {
        const nowStr = toSqliteDateTime(now);
        data.lastActiveAt = nowStr;
        await db
          .prepare("UPDATE sessions SET last_active_at = ? WHERE token_hash = ?")
          .bind(nowStr, tokenHash)
          .run();
      }

      return data;
    }
  }

  // Fallback to D1
  const row = await db
    .prepare(
      "SELECT id, user_id, expires_at, last_active_at FROM sessions WHERE token_hash = ?",
    )
    .bind(tokenHash)
    .first<{ id: string; user_id: string; expires_at: string; last_active_at: string }>();

  if (!row) return null;

  const now = new Date();
  const expiresAt = new Date(normalizeDateTime(row.expires_at));
  const lastActive = new Date(normalizeDateTime(row.last_active_at));

  if (now > expiresAt) {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }

  if ((now.getTime() - lastActive.getTime()) / 1000 > IDLE_TIMEOUT) {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }

  const data: SessionData = {
    userId: row.user_id,
    sessionId: row.id,
    expiresAt: row.expires_at,
    lastActiveAt: row.last_active_at,
  };

  // Throttled activity update
  if ((now.getTime() - lastActive.getTime()) / 1000 > ACTIVITY_THROTTLE) {
    const nowStr = toSqliteDateTime(now);
    data.lastActiveAt = nowStr;
    await db
      .prepare("UPDATE sessions SET last_active_at = ? WHERE token_hash = ?")
      .bind(nowStr, tokenHash)
      .run();
  }

  // Cache in KV
  await kv.put(cacheKey, JSON.stringify(data), { expirationTtl: SESSION_CACHE_TTL });

  return data;
}

export async function invalidateSession(
  db: D1Database,
  kv: KVNamespace,
  tokenHash: string,
): Promise<void> {
  await Promise.all([
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run(),
    kv.delete(`session:${tokenHash}`),
  ]);
}

export async function invalidateOtherSessions(
  db: D1Database,
  kv: KVNamespace,
  userId: string,
  currentTokenHash: string,
): Promise<void> {
  // Get all other session hashes to clear KV
  const { results } = await db
    .prepare("SELECT token_hash FROM sessions WHERE user_id = ? AND token_hash != ?")
    .bind(userId, currentTokenHash)
    .all<{ token_hash: string }>();

  const deletes: Promise<unknown>[] = results.map((r) => kv.delete(`session:${r.token_hash}`));
  deletes.push(
    db
      .prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
      .bind(userId, currentTokenHash)
      .run(),
  );

  await Promise.all(deletes);
}

export async function invalidateAllUserSessions(
  db: D1Database,
  kv: KVNamespace,
  userId: string,
): Promise<void> {
  const { results } = await db
    .prepare("SELECT token_hash FROM sessions WHERE user_id = ?")
    .bind(userId)
    .all<{ token_hash: string }>();

  const deletes: Promise<unknown>[] = results.map((r) => kv.delete(`session:${r.token_hash}`));
  deletes.push(
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run(),
  );

  await Promise.all(deletes);
}

// ─── Cookie Helpers ──────────────────────────────────────

function isDev(env: Env): boolean {
  return env.ENVIRONMENT === "development";
}

export function getSessionCookieName(env: Env): string {
  return isDev(env) ? "session" : "__Host-session";
}

export function setSessionCookie(c: Context, token: string, env: Env): void {
  const name = getSessionCookieName(env);
  setCookie(c, name, token, {
    httpOnly: true,
    secure: !isDev(env),
    sameSite: "Lax",
    path: "/",
    maxAge: ABSOLUTE_EXPIRY,
  });
}

export function clearSessionCookie(c: Context, env: Env): void {
  const name = getSessionCookieName(env);
  deleteCookie(c, name, {
    path: "/",
    secure: !isDev(env),
    httpOnly: true,
    sameSite: "Lax",
  });
}

export function getSessionTokenFromCookie(c: Context, env: Env): string | null {
  const name = getSessionCookieName(env);
  return getCookie(c, name) ?? null;
}

// ─── OAuth State KV ──────────────────────────────────────

export interface OAuthStateData {
  codeVerifier: string;
  nonce?: string;
  linkUserId?: string;
}

export async function storeOAuthState(
  kv: KVNamespace,
  state: string,
  data: OAuthStateData,
): Promise<void> {
  await kv.put(`oauth:state:${state}`, JSON.stringify(data), { expirationTtl: STATE_TTL });
}

/**
 * Consume OAuth state (best-effort one-time use).
 * KV get+delete is not atomic due to eventual consistency, so replay
 * prevention is best-effort. PKCE + nonce provide additional protection.
 */
export async function consumeOAuthState(
  kv: KVNamespace,
  state: string,
): Promise<OAuthStateData | null> {
  const key = `oauth:state:${state}`;
  const raw = await kv.get(key);
  if (!raw) return null;
  await kv.delete(key);
  try {
    return JSON.parse(raw) as OAuthStateData;
  } catch {
    return null;
  }
}

// ─── State Cookie (double-submit) ────────────────────────

function getStateCookieName(env: Env): string {
  return isDev(env) ? "oauth_state" : "__Host-oauth_state";
}

export function setStateCookie(c: Context, state: string, env: Env): void {
  const name = getStateCookieName(env);
  setCookie(c, name, state, {
    httpOnly: true,
    secure: !isDev(env),
    sameSite: "Lax",
    path: "/",
    maxAge: STATE_TTL,
  });
}

export function getStateCookie(c: Context, env: Env): string | null {
  return getCookie(c, getStateCookieName(env)) ?? null;
}

export function clearStateCookie(c: Context, env: Env): void {
  deleteCookie(c, getStateCookieName(env), {
    path: "/",
    secure: !isDev(env),
    httpOnly: true,
    sameSite: "Lax",
  });
}
