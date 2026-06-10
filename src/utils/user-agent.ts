/**
 * Helpers for resolving the WakaTime-style User-Agent string into a
 * `user_agents` row foreign key (Issue #99).
 *
 * wakatime-cli composes its User-Agent like:
 *
 *   wakatime/<cli-ver> (<os-name>-<core>-<platform>) <runtime> <plugin>/<plugin-ver>
 *
 * Example: `wakatime/v1.65.2 (linux-6.5.0-amd64) go1.21.5 vscode-wakatime/24.0.4`
 *
 * Editor and OS are derived server-side, mirroring WakaTime's behaviour where
 * the server is the parser of record. Parsing is best-effort; unrecognised
 * shapes leave the optional columns NULL.
 */

import { INPUT_LIMITS, truncateTo } from "./input-limits";

export interface ParsedUserAgent {
  /** Editor or plugin name (e.g. "vscode-wakatime"). Best-effort. */
  editor: string | null;
  /** Plugin version (e.g. "24.0.4"). Best-effort. */
  version: string | null;
  /** Operating system family (e.g. "linux", "darwin", "windows"). Best-effort. */
  os: string | null;
}

/**
 * Extract editor / version / os from a wakatime-cli-style User-Agent string.
 * Returns nulls when the shape is unrecognised; the call site stores the raw
 * value alongside whatever was parsed, so a parse failure does not lose data.
 */
export function parseUserAgent(value: string): ParsedUserAgent {
  let editor: string | null = null;
  let version: string | null = null;
  let os: string | null = null;

  const tokens = value.split(/\s+/).filter((t) => t.length > 0);
  const firstToken = tokens[0]?.toLowerCase();
  if (!firstToken?.startsWith("wakatime/")) {
    return { editor, version, os };
  }

  // OS: first segment inside the parenthesised triple. wakatime-cli emits
  //   (os-core-platform)
  // where os is "linux" / "darwin" / "windows" / etc.
  const paren = value.match(/\(([^)]+)\)/);
  if (paren) {
    const inside = paren[1].trim();
    const firstDash = inside.indexOf("-");
    const candidate = firstDash >= 0 ? inside.slice(0, firstDash) : inside;
    if (candidate.length > 0 && candidate.length <= 32) {
      os = candidate.toLowerCase();
    }
  }

  // Editor + version: the last `<name>/<version>` token. wakatime-cli always
  // appends the plugin identifier at the tail, so this is the most reliable
  // anchor for the editor field.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const slashIdx = tokens[i].lastIndexOf("/");
    if (slashIdx <= 0 || slashIdx === tokens[i].length - 1) continue;
    const name = tokens[i].slice(0, slashIdx);
    const ver = tokens[i].slice(slashIdx + 1);
    // Skip the wakatime/<cli-ver> prefix when picking the editor — that token
    // is the CLI itself, not the editor / plugin.
    if (name.toLowerCase() === "wakatime") continue;
    editor = name;
    version = ver;
    break;
  }

  return { editor, version, os };
}

/**
 * Upsert a `user_agents` row for the given user + raw value and return its id.
 * Returns null when `value` is falsy so the caller can store NULL.
 *
 * UNIQUE(user_id, value) makes the INSERT…ON CONFLICT … RETURNING idempotent:
 * the same User-Agent string returns the same id across heartbeats.
 *
 * The optional `cache` argument is used by bulk inserts to amortise repeated
 * upserts when many heartbeats share the same User-Agent.
 */
export async function resolveUserAgentId(
  db: D1Database,
  userId: string,
  value: string | null | undefined,
  cache?: Map<string, string>,
): Promise<string | null> {
  if (!value) return null;
  // Ambient User-Agent headers may exceed the contract cap; truncate rather
  // than reject (Issue #158, research R-5). Body-supplied values are
  // validated upstream, so this is a no-op for them.
  value = truncateTo(value, INPUT_LIMITS.userAgent);
  const cached = cache?.get(value);
  if (cached) return cached;

  const parsed = parseUserAgent(value);

  const row = await db
    .prepare(
      `INSERT INTO user_agents (id, user_id, value, editor, version, os, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT (user_id, value) DO UPDATE SET
         last_seen_at = datetime('now'),
         editor = COALESCE(user_agents.editor, excluded.editor),
         version = COALESCE(user_agents.version, excluded.version),
         os = COALESCE(user_agents.os, excluded.os)
       RETURNING id`,
    )
    .bind(
      crypto.randomUUID(),
      userId,
      value,
      parsed.editor,
      parsed.version,
      parsed.os,
    )
    .first<{ id: string }>();

  const id = row?.id ?? null;
  if (id && cache) cache.set(value, id);
  return id;
}
