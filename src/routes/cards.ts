import { Hono } from "hono";
import type { AuthEnv, Env } from "../types";
import type { components } from "../types/generated";
import type { Context } from "hono";
import { authMiddleware } from "../middleware/auth";
import { rateLimitExceeded, tooManyRequests } from "../middleware/rate-limit";
import { getHeatmapData } from "../utils/cards/data";
import { renderHeatmapSvg, resolveThemeName } from "../utils/cards/render";
import {
  buildCardCacheKey,
  cardCacheControl,
  cardCacheTtlSeconds,
  computeCardEtag,
  type CardCacheValue,
} from "../utils/cards/cache";

type EmbedSettings = components["schemas"]["EmbedSettings"];
type EmbedSettingsUpdate = components["schemas"]["EmbedSettingsUpdate"];

// Defaults applied when a user has no embed_settings row (default-safe: OFF).
const DEFAULT_SETTINGS: EmbedSettings = {
  enabled: false,
  freshness_minutes: 15,
  default_theme: "default",
};

const FRESHNESS_MIN = 1;
const FRESHNESS_MAX = 1440; // one day
const THEME_NAME_MAX = 32;

interface SettingsRow {
  enabled: number;
  freshness_minutes: number;
  default_theme: string;
  created_at: string;
  modified_at: string;
}

async function loadEmbedSettings(db: D1Database, userId: string): Promise<EmbedSettings> {
  const row = await db
    .prepare(
      "SELECT enabled, freshness_minutes, default_theme, created_at, modified_at FROM embed_settings WHERE user_id = ?",
    )
    .bind(userId)
    .first<SettingsRow>();
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    enabled: row.enabled === 1,
    freshness_minutes: row.freshness_minutes,
    default_theme: row.default_theme,
    created_at: row.created_at,
    modified_at: row.modified_at,
  };
}

// ============================================================
// Authenticated settings: /users/current/embed_settings
// ============================================================

export const cardsSettings = new Hono<AuthEnv>();

cardsSettings.use("/*", authMiddleware);

cardsSettings.get("/embed_settings", async (c) => {
  const userId = c.get("userId");
  const settings = await loadEmbedSettings(c.env.DB, userId);
  return c.json({ data: settings });
});

cardsSettings.patch("/embed_settings", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => null)) as EmbedSettingsUpdate | null;
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const current = await loadEmbedSettings(c.env.DB, userId);
  const next: EmbedSettings = { ...current };

  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled must be a boolean" }, 400);
    }
    next.enabled = body.enabled;
  }
  if ("freshness_minutes" in body) {
    const n = body.freshness_minutes;
    if (
      typeof n !== "number" ||
      !Number.isInteger(n) ||
      n < FRESHNESS_MIN ||
      n > FRESHNESS_MAX
    ) {
      return c.json(
        { error: `freshness_minutes must be an integer between ${FRESHNESS_MIN} and ${FRESHNESS_MAX}` },
        400,
      );
    }
    next.freshness_minutes = n;
  }
  if ("default_theme" in body) {
    const t = body.default_theme;
    if (typeof t !== "string" || t.length < 1 || t.length > THEME_NAME_MAX) {
      return c.json({ error: `default_theme must be a string of 1-${THEME_NAME_MAX} characters` }, 400);
    }
    next.default_theme = t;
  }

  await c.env.DB
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

  const updated = await loadEmbedSettings(c.env.DB, userId);
  return c.json({ data: updated });
});

// ============================================================
// Public cards: /users/{username}/cards/{card_type}.svg
// Unauthenticated (security: []). The visibility OFF gate runs before any
// rate-limit budget, cache lookup, or aggregate read so a private profile
// cannot be probed and generates no load (FR-008).
// ============================================================

export const cardsPublic = new Hono<{ Bindings: Env }>();

// P1 ships the heatmap. summary/languages are valid in the contract but land in
// P2; until then they are reported as not found.
const IMPLEMENTED_CARD_TYPES = new Set(["heatmap"]);

function notFound(c: Context): Response {
  return c.json({ error: "Not found" }, 404, { "Cache-Control": "no-store" });
}

interface PublicUserRow {
  id: string;
  username: string;
  timezone: string;
  timeout: number;
}

cardsPublic.get("/users/:username/cards/:file", async (c) => {
  const username = c.req.param("username");
  const file = c.req.param("file");
  if (!file.endsWith(".svg")) return notFound(c);
  const cardType = file.slice(0, -".svg".length);
  if (!IMPLEMENTED_CARD_TYPES.has(cardType)) return notFound(c);

  const user = await c.env.DB
    .prepare("SELECT id, username, timezone, timeout FROM users WHERE username = ?")
    .bind(username)
    .first<PublicUserRow>();
  if (!user) return notFound(c);

  const settings = await loadEmbedSettings(c.env.DB, user.id);
  if (!settings.enabled) return notFound(c);

  // Rate limit only reachable profiles, after the OFF gate (FR-008) and before
  // the cache/render work a miss would trigger.
  if (
    await rateLimitExceeded(
      c.env.RATE_LIMIT_EMBED_CARDS,
      c.req.raw.headers,
      `embed-cards:${user.id}`,
      "RATE_LIMIT_EMBED_CARDS",
    )
  ) {
    return tooManyRequests(c);
  }

  const themeName = resolveThemeName(c.req.query("theme") ?? settings.default_theme);
  const v = c.req.query("v") ?? "";
  const ifNoneMatch = c.req.raw.headers.get("If-None-Match");

  const cacheKey = buildCardCacheKey({
    userId: user.id,
    cardType,
    range: "year",
    theme: themeName,
    templateId: "",
    v,
    settingsModifiedAt: settings.modified_at ?? "",
  });

  const cached = (await c.env.KV.get(cacheKey, "json")) as CardCacheValue | null;
  if (cached) {
    return svgResponse(cached.svg, cached.etag, settings.freshness_minutes, ifNoneMatch);
  }

  const data = await getHeatmapData(c.env.DB, user.id, user.timezone, user.timeout);
  const svg = renderHeatmapSvg({
    username: user.username,
    dayTotals: data.dayTotals,
    todayStr: data.todayStr,
    totalSeconds: data.totalSeconds,
    theme: themeName,
  });
  const etag = await computeCardEtag(svg);

  const value: CardCacheValue = { svg, etag, generated_at: new Date().toISOString() };
  await c.env.KV.put(cacheKey, JSON.stringify(value), {
    expirationTtl: cardCacheTtlSeconds(settings.freshness_minutes),
  });

  return svgResponse(svg, etag, settings.freshness_minutes, ifNoneMatch);
});

function svgResponse(
  svg: string,
  etag: string,
  freshnessMinutes: number,
  ifNoneMatch: string | null,
): Response {
  const cacheControl = cardCacheControl(freshnessMinutes);
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, "Cache-Control": cacheControl },
    });
  }
  return new Response(svg, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": cacheControl,
      ETag: etag,
    },
  });
}
