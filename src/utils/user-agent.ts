/**
 * Helpers for resolving compatible CLI-style User-Agent strings into a
 * `user_agents` row foreign key (Issue #99).
 *
 * Compatible CLI clients commonly compose User-Agent values like:
 *
 *   wakatime/<cli-ver> (<os-name>-<core>-<platform>) <runtime> <plugin>/<plugin-ver>
 *
 * Example: `wakatime/v1.65.2 (linux-6.5.0-amd64) go1.21.5 vscode-wakatime/24.0.4`
 *
 * Editor and OS are derived server-side from the raw client string. Parsing is
 * best-effort; unrecognised shapes leave the optional columns NULL.
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
 * Extract editor / version / os from a compatible CLI-style User-Agent string.
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

  // OS: first segment inside the parenthesised triple. Compatible CLI clients emit
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

  // Editor + version: the last `<name>/<version>` token. Compatible CLI clients
  // append the plugin identifier at the tail, so this is the most reliable
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
 * Known Anthropic model families as they appear in a compatible AI-tool
 * User-Agent (e.g. `opus/4-8`, `fable/5`). The token after the slash is the
 * version; `opus/4-8` normalizes to `claude-opus-4-8`, matching the model key
 * used by the owner-managed pricing table (Issue #200).
 */
const ANTHROPIC_MODEL_FAMILIES = new Set([
  "opus", "sonnet", "haiku", "fable", "mythos",
]);

/**
 * Map an AI coding tool (the `<tool>-wakatime` plugin that emitted the
 * heartbeat) to the LLM provider whose models it drives.
 */
const AI_TOOL_PROVIDER: Record<string, string> = {
  "claude-code": "anthropic",
  "codex-cli": "openai",
};

export interface AiIdentity {
  /** LLM provider (e.g. "anthropic", "openai"). Null when unrecognised. */
  provider: string | null;
  /** Canonical model id (e.g. "claude-opus-4-8"). Null when not derivable. */
  model: string | null;
}

/**
 * Best-effort derivation of the AI provider/model from a compatible AI-tool
 * User-Agent, for `ai coding` heartbeats whose client did not populate
 * `ai_provider` / `ai_model` explicitly (Issue #200). Compatible AI plugins put
 * the model in the User-Agent (e.g. `... opus/4-8 claude-code/2.1.205
 * claude-code-wakatime/4.1.0`) rather than in the heartbeat body, so the rollup
 * would otherwise bucket every provider/model as `unknown`.
 *
 * The emitting tool is identified by its `<tool>-wakatime/<ver>` plugin token;
 * the provider follows from the tool. The `<family>/<ver>` model token is only
 * attributed when the provider is Anthropic — the same token can co-occur in a
 * co-running tool's heartbeat (e.g. a `codex-cli` heartbeat whose UA still
 * carries `opus/4-8`), so it is never cross-attributed to another provider.
 * Returns nulls for unrecognised shapes.
 */
export function deriveAiIdentity(value: string): AiIdentity {
  const tokens = value.split(/\s+/).filter((t) => t.length > 0);

  // The `<tool>-wakatime/<ver>` plugin identifier at the tail is the definitive
  // signal for which AI tool actually produced this heartbeat.
  let tool: string | null = null;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const slash = tokens[i].lastIndexOf("/");
    if (slash <= 0) continue;
    const name = tokens[i].slice(0, slash).toLowerCase();
    if (name.endsWith("-wakatime")) {
      tool = name.slice(0, -"-wakatime".length);
      break;
    }
  }
  // Fallback: no plugin token — accept a bare `<tool>/<ver>` known-tool token,
  // but only when a single known tool is present. A co-running pair (e.g. both
  // `claude-code/…` and `codex-cli/…`) is ambiguous without the disambiguating
  // `-wakatime` plugin token, so it is left unresolved.
  if (tool === null) {
    const bare = new Set<string>();
    for (const t of tokens) {
      const slash = t.indexOf("/");
      if (slash <= 0) continue;
      const name = t.slice(0, slash).toLowerCase();
      if (AI_TOOL_PROVIDER[name] !== undefined) bare.add(name);
    }
    if (bare.size === 1) tool = [...bare][0];
  }
  const provider = tool ? (AI_TOOL_PROVIDER[tool] ?? null) : null;

  // Model: the `<family>/<ver>` token, attributed only when the provider is
  // Anthropic (never cross-attributed to a codex/other heartbeat).
  let model: string | null = null;
  if (provider === "anthropic") {
    for (const t of tokens) {
      const slash = t.indexOf("/");
      if (slash <= 0 || slash === t.length - 1) continue;
      const family = t.slice(0, slash).toLowerCase();
      if (ANTHROPIC_MODEL_FAMILIES.has(family)) {
        model = `claude-${family}-${t.slice(slash + 1)}`;
        break;
      }
    }
  }

  return { provider, model };
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
