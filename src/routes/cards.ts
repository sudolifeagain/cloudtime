import { Hono } from "hono";
import type { AuthEnv, Env } from "../types";
import type { Context } from "hono";
import { authMiddleware } from "../middleware/auth";
import { rateLimitExceeded, tooManyRequests } from "../middleware/rate-limit";
import {
  getHeatmapData,
  getLanguagesCardData,
  getStreakData,
  getSummaryCardData,
  resolveCardRange,
  type CardRange,
} from "../utils/cards/data";
import {
  renderHeatmapSvg,
  renderLanguagesSvg,
  renderStreakSvg,
  renderSummarySvg,
  resolveThemeName,
} from "../utils/cards/render";
import {
  loadEmbedSettings,
  prepareEmbedSettingsUpdate,
  saveEmbedSettings,
  type EmbedSettingsUpdate,
} from "../utils/embed-settings";
import {
  buildCardCacheKey,
  cardCacheControl,
  cardCacheTtlSeconds,
  computeCardEtag,
  type CardCacheValue,
} from "../utils/cards/cache";

const USERNAME_MAX = 64;
const RANGE_MAX = 32;
const CACHE_BUSTER_MAX = 64;

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
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const current = await loadEmbedSettings(c.env.DB, userId);
  const prepared = prepareEmbedSettingsUpdate(current, body);
  if (!prepared.ok) {
    return c.json({ error: prepared.error }, 400);
  }

  const updated = await saveEmbedSettings(c.env.DB, userId, prepared.next);
  return c.json({ data: updated });
});

// ============================================================
// Public cards: /users/{username}/cards/{card_type}.svg
// Unauthenticated (security: []). The visibility OFF gate runs before any
// rate-limit budget, cache lookup, or aggregate read so a private profile
// cannot be probed and generates no load (FR-008).
// ============================================================

export const cardsPublic = new Hono<{ Bindings: Env }>();

const IMPLEMENTED_CARD_TYPES = new Set(["heatmap", "summary", "languages", "streak"]);

function notFound(c: Context): Response {
  return c.json({ error: "Not found" }, 404, { "Cache-Control": "no-store" });
}

function badRequest(c: Context, error: string): Response {
  return c.json({ error }, 400);
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
  if (username.length < 1 || username.length > USERNAME_MAX) {
    return badRequest(c, `username must be 1-${USERNAME_MAX} characters`);
  }
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
  const rangeParam = c.req.query("range");
  if ((rangeParam?.length ?? 0) > RANGE_MAX) {
    return badRequest(c, `range must be at most ${RANGE_MAX} characters`);
  }
  const cardRange = resolveCardRange(rangeParam);
  const v = c.req.query("v") ?? "";
  if (v.length > CACHE_BUSTER_MAX) {
    return badRequest(c, `v must be at most ${CACHE_BUSTER_MAX} characters`);
  }
  const ifNoneMatch = c.req.raw.headers.get("If-None-Match");
  const cacheRange = cardType === "heatmap" ? "year" : cardRange.key;

  const cacheKey = buildCardCacheKey({
    userId: user.id,
    cardType,
    range: cacheRange,
    theme: themeName,
    templateId: "",
    v,
    settingsModifiedAt: settings.modified_at ?? "",
  });

  const cached = (await c.env.KV.get(cacheKey, "json")) as CardCacheValue | null;
  if (cached) {
    return svgResponse(cached.svg, cached.etag, settings.freshness_minutes, ifNoneMatch);
  }

  const svg = await renderPublicCardSvg(c.env.DB, cardType, user, themeName, cardRange);
  const etag = await computeCardEtag(svg);

  const value: CardCacheValue = { svg, etag, generated_at: new Date().toISOString() };
  await c.env.KV.put(cacheKey, JSON.stringify(value), {
    expirationTtl: cardCacheTtlSeconds(settings.freshness_minutes),
  });

  return svgResponse(svg, etag, settings.freshness_minutes, ifNoneMatch);
});

async function renderPublicCardSvg(
  db: D1Database,
  cardType: string,
  user: PublicUserRow,
  themeName: string,
  cardRange: CardRange,
): Promise<string> {
  if (cardType === "heatmap") {
    const data = await getHeatmapData(db, user.id, user.timezone, user.timeout);
    return renderHeatmapSvg({
      username: user.username,
      dayTotals: data.dayTotals,
      todayStr: data.todayStr,
      totalSeconds: data.totalSeconds,
      theme: themeName,
    });
  }

  if (cardType === "streak") {
    const data = await getStreakData(db, user.id, user.timezone, user.timeout, cardRange.days);
    return renderStreakSvg({
      username: user.username,
      currentStreak: data.currentStreak,
      longestStreak: data.longestStreak,
      trackedDays: data.trackedDays,
      totalSeconds: data.totalSeconds,
      theme: themeName,
      rangeLabel: cardRange.label,
    });
  }

  if (cardType === "summary") {
    const data = await getSummaryCardData(db, user.id, user.timezone, user.timeout, cardRange.days);
    return renderSummarySvg({
      username: user.username,
      totalSeconds: data.totalSeconds,
      dailyAverageSeconds: data.dailyAverageSeconds,
      bestDay: data.bestDay,
      topLanguage: data.topLanguage,
      theme: themeName,
      rangeLabel: cardRange.label,
    });
  }

  if (cardType === "languages") {
    const data = await getLanguagesCardData(db, user.id, user.timezone, user.timeout, cardRange.days);
    return renderLanguagesSvg({
      username: user.username,
      totalSeconds: data.totalSeconds,
      languages: data.languages,
      theme: themeName,
      rangeLabel: cardRange.label,
    });
  }

  throw new Error(`Unsupported card type: ${cardType}`);
}

function svgResponse(
  svg: string,
  etag: string,
  freshnessMinutes: number,
  ifNoneMatch: string | null,
): Response {
  const cacheControl = cardCacheControl(freshnessMinutes);
  if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) {
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

function normalizeEtagForComparison(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("W/") ? trimmed.slice(2).trim() : trimmed;
}

function etagMatches(ifNoneMatch: string, etag: string): boolean {
  const current = normalizeEtagForComparison(etag);
  return ifNoneMatch
    .split(",")
    .some((candidate) => {
      const normalized = normalizeEtagForComparison(candidate);
      return normalized === "*" || normalized === current;
    });
}
