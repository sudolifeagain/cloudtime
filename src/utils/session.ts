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

const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;

// ─── Helpers ─────────────────────────────────────────────

function isValidTokenHash(hash: string): boolean {
  return TOKEN_HASH_RE.test(hash);
}

/** Throttled activity update — writes D1 only if last activity exceeds threshold. */
function maybeUpdateActivity(
  db: D1Database,
  tokenHash: string,
  now: Date,
  lastActive: Date,
  data: SessionData,
): Promise<void> {
  if ((now.getTime() - lastActive.getTime()) / 1000 > ACTIVITY_THROTTLE) {
    const nowStr = toSqliteDateTime(now);
    data.lastActiveAt = nowStr;
    return db
      .prepare("UPDATE sessions SET last_active_at = ? WHERE token_hash = ?")
      .bind(nowStr, tokenHash)
      .run()
      .then(() => {});
  }
  return Promise.resolve();
}

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
  const country = request.cf?.country as string | undefined ?? null;
  const city = request.cf?.city as string | undefined ?? null;
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
  if (!isValidTokenHash(tokenHash)) return null;

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
      await maybeUpdateActivity(db, tokenHash, now, lastActive, data);

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

  await maybeUpdateActivity(db, tokenHash, now, lastActive, data);

  // Cache in KV
  await kv.put(cacheKey, JSON.stringify(data), { expirationTtl: SESSION_CACHE_TTL });

  return data;
}

export async function invalidateSession(
  db: D1Database,
  kv: KVNamespace,
  tokenHash: string,
): Promise<void> {
  // D1 first — if it fails the session stays valid (safe).
  // If KV delete were first and D1 failed, the session would be re-cached on next validate.
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  await kv.delete(`session:${tokenHash}`);
}

export async function invalidateOtherSessions(
  db: D1Database,
  kv: KVNamespace,
  userId: string,
  currentTokenHash: string,
): Promise<void> {
  // Atomic DELETE + RETURNING avoids TOCTOU between SELECT and DELETE
  const { results } = await db
    .prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ? RETURNING token_hash")
    .bind(userId, currentTokenHash)
    .all<{ token_hash: string }>();

  await Promise.all(results.map((r) => kv.delete(`session:${r.token_hash}`)));
}

export async function invalidateAllUserSessions(
  db: D1Database,
  kv: KVNamespace,
  userId: string,
): Promise<void> {
  // Atomic DELETE + RETURNING avoids TOCTOU between SELECT and DELETE
  const { results } = await db
    .prepare("DELETE FROM sessions WHERE user_id = ? RETURNING token_hash")
    .bind(userId)
    .all<{ token_hash: string }>();

  await Promise.all(results.map((r) => kv.delete(`session:${r.token_hash}`)));
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
