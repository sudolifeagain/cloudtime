import type { components } from "../types/generated";
import { resolveThemeName } from "./cards/render";

export type EmbedSettings = components["schemas"]["EmbedSettings"];
export type EmbedSettingsUpdate = components["schemas"]["EmbedSettingsUpdate"];

export const DEFAULT_EMBED_SETTINGS: EmbedSettings = {
  enabled: false,
  freshness_minutes: 15,
  default_theme: "default",
};

export const EMBED_FRESHNESS_MIN = 1;
export const EMBED_FRESHNESS_MAX = 1440; // one day

const THEME_NAME_MAX = 32;
const THEME_NAME_RE = /^[a-z0-9_-]+$/;

interface SettingsRow {
  enabled: number;
  freshness_minutes: number;
  default_theme: string;
  created_at: string;
  modified_at: string;
}

export type PreparedEmbedSettingsUpdate =
  | { ok: true; next: EmbedSettings }
  | { ok: false; error: string };

export async function loadEmbedSettings(db: D1Database, userId: string): Promise<EmbedSettings> {
  const row = await db
    .prepare(
      "SELECT enabled, freshness_minutes, default_theme, created_at, modified_at FROM embed_settings WHERE user_id = ?",
    )
    .bind(userId)
    .first<SettingsRow>();
  if (!row) return { ...DEFAULT_EMBED_SETTINGS };
  return {
    enabled: row.enabled === 1,
    freshness_minutes: row.freshness_minutes,
    default_theme: row.default_theme,
    created_at: row.created_at,
    modified_at: row.modified_at,
  };
}

export function prepareEmbedSettingsUpdate(
  current: EmbedSettings,
  body: EmbedSettingsUpdate,
): PreparedEmbedSettingsUpdate {
  const next: EmbedSettings = { ...current };
  let updates = 0;

  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") {
      return { ok: false, error: "enabled must be a boolean" };
    }
    next.enabled = body.enabled;
    updates++;
  }

  if ("freshness_minutes" in body) {
    const n = body.freshness_minutes;
    if (
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < EMBED_FRESHNESS_MIN ||
      n > EMBED_FRESHNESS_MAX
    ) {
      return {
        ok: false,
        error: `freshness_minutes must be an integer between ${EMBED_FRESHNESS_MIN} and ${EMBED_FRESHNESS_MAX}`,
      };
    }
    next.freshness_minutes = n;
    updates++;
  }

  if ("default_theme" in body) {
    const t = body.default_theme;
    if (
      typeof t !== "string" ||
      t.length < 1 ||
      t.length > THEME_NAME_MAX ||
      !THEME_NAME_RE.test(t)
    ) {
      return {
        ok: false,
        error: `default_theme must be 1-${THEME_NAME_MAX} lowercase letters, numbers, hyphens, or underscores`,
      };
    }
    next.default_theme = resolveThemeName(t);
    updates++;
  }

  if (updates === 0) {
    return { ok: false, error: "No fields to update" };
  }

  return { ok: true, next };
}

export async function saveEmbedSettings(
  db: D1Database,
  userId: string,
  next: EmbedSettings,
): Promise<EmbedSettings> {
  await db
    .prepare(
      `INSERT INTO embed_settings (user_id, enabled, freshness_minutes, default_theme, created_at, modified_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         enabled = excluded.enabled,
         freshness_minutes = excluded.freshness_minutes,
         default_theme = excluded.default_theme,
         modified_at = datetime('now')`,
    )
    .bind(userId, next.enabled ? 1 : 0, next.freshness_minutes, next.default_theme)
    .run();

  return loadEmbedSettings(db, userId);
}
