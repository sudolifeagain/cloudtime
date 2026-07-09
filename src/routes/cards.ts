import { Hono } from "hono";
import type { AuthEnv, Env } from "../types";
import type { Context } from "hono";
import type { components, operations } from "../types/generated";
import { authMiddleware } from "../middleware/auth";
import { rateLimitExceeded, tooManyRequests } from "../middleware/rate-limit";
import {
  DEFAULT_PROFILE_METRICS,
  PROFILE_METRIC_KEYS,
  getCodingTimeBadgeData,
  getCurrentStreakBadgeData,
  getGoalProgressBadgeData,
  getHeatmapData,
  getLanguagesCardData,
  getProfileCardData,
  getStreakData,
  getSummaryCardData,
  getTopLanguageBadgeData,
  resolveBadgeRange,
  resolveCardRange,
  resolveEligibleGoal,
  type BadgeData,
  type CardRange,
  type EligibleGoal,
  type ProfileMetricKey,
} from "../utils/cards/data";
import {
  renderBadgeSvg,
  renderHeatmapSvg,
  renderLanguagesSvg,
  renderProfileCardSvg,
  renderStreakSvg,
  renderSummarySvg,
  resolveThemeName,
} from "../utils/cards/render";
import {
  defaultTemplateValues,
  formatDays,
  formatTemplatePercent,
  renderTemplateSvg,
  validateTemplateName,
  validateTemplateSvg,
  type CardTemplateValues,
} from "../utils/cards/templates";
import {
  loadEmbedSettings,
  prepareEmbedSettingsUpdate,
  saveEmbedSettings,
  type EmbedSettingsUpdate,
} from "../utils/embed-settings";
import {
  buildBadgeCacheKey,
  buildCardCacheKey,
  cardCacheControl,
  cardCacheTtlSeconds,
  computeCardEtag,
  type CardCacheValue,
} from "../utils/cards/cache";
import { formatHumanReadable } from "../utils/time-format";

const USERNAME_MAX = 64;
const RANGE_MAX = 32;
const CACHE_BUSTER_MAX = 64;
const TEMPLATE_ID_MAX = 64;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type EmbedTemplate = components["schemas"]["EmbedTemplate"];
type EmbedTemplateInput = components["schemas"]["EmbedTemplateInput"];
type EmbedTemplateUpdate = operations["updateEmbedTemplate"]["requestBody"]["content"]["application/json"];

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

cardsSettings.get("/embed_templates", async (c) => {
  const userId = c.get("userId");
  const templates = await listEmbedTemplates(c.env.DB, userId);
  return c.json({ data: templates });
});

cardsSettings.post("/embed_templates", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json().catch(() => null)) as EmbedTemplateInput | null;
  if (!isPlainObject(body)) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const prepared = prepareTemplateInput(body);
  if (!prepared.ok) {
    return c.json({ error: prepared.error }, 400);
  }

  const id = crypto.randomUUID();
  await c.env.DB
    .prepare(
      `INSERT INTO embed_templates (id, user_id, name, template_svg, created_at, modified_at)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(id, userId, prepared.input.name, prepared.input.template_svg)
    .run();

  const template = await loadEmbedTemplate(c.env.DB, userId, id);
  if (!template) throw new Error("Created embed template could not be loaded");
  return c.json({ data: template }, 201);
});

cardsSettings.get("/embed_templates/:template_id", async (c) => {
  const userId = c.get("userId");
  const templateId = c.req.param("template_id");
  const template = await loadEmbedTemplate(c.env.DB, userId, templateId);
  if (!template) return notFound(c);
  return c.json({ data: template });
});

cardsSettings.patch("/embed_templates/:template_id", async (c) => {
  const userId = c.get("userId");
  const templateId = c.req.param("template_id");
  const existing = await loadEmbedTemplate(c.env.DB, userId, templateId);
  if (!existing) return notFound(c);

  const body = (await c.req.json().catch(() => null)) as EmbedTemplateUpdate | null;
  if (!isPlainObject(body)) {
    return c.json({ error: "Invalid request body" }, 400);
  }

  const prepared = prepareTemplateUpdate(existing, body);
  if (!prepared.ok) {
    return c.json({ error: prepared.error }, 400);
  }

  await c.env.DB
    .prepare(
      `UPDATE embed_templates
       SET name = ?, template_svg = ?, modified_at = datetime('now')
       WHERE id = ? AND user_id = ?`,
    )
    .bind(prepared.next.name, prepared.next.template_svg, templateId, userId)
    .run();

  const updated = await loadEmbedTemplate(c.env.DB, userId, templateId);
  if (!updated) throw new Error("Updated embed template could not be loaded");
  return c.json({ data: updated });
});

cardsSettings.delete("/embed_templates/:template_id", async (c) => {
  const userId = c.get("userId");
  const templateId = c.req.param("template_id");
  const existing = await loadEmbedTemplate(c.env.DB, userId, templateId);
  if (!existing) return notFound(c);

  await c.env.DB
    .prepare("DELETE FROM embed_templates WHERE id = ? AND user_id = ?")
    .bind(templateId, userId)
    .run();

  return new Response(null, { status: 204 });
});

// ============================================================
// Public cards: /users/{username}/cards/{card_type}.svg
// Unauthenticated (security: []). The visibility OFF gate runs before any
// rate-limit budget, cache lookup, or aggregate read so a private profile
// cannot be probed and generates no load (FR-008).
// ============================================================

export const cardsPublic = new Hono<{ Bindings: Env }>();

const IMPLEMENTED_CARD_TYPES = new Set(["heatmap", "summary", "languages", "streak", "profile"]);

type BadgeQuery = NonNullable<operations["getEmbeddableBadge"]["parameters"]["query"]>;
type BadgeTypeParam = operations["getEmbeddableBadge"]["parameters"]["path"]["badge_type"];
type BadgeStyleParam = NonNullable<BadgeQuery["style"]>;
type CardQuery = NonNullable<operations["getEmbeddableCard"]["parameters"]["query"]>;
type ProfileLayoutParam = NonNullable<CardQuery["layout"]>;

const BADGE_TYPES = new Set<string>([
  "coding_time",
  "top_language",
  "current_streak",
  "goal_progress",
] satisfies BadgeTypeParam[]);
const BADGE_STYLES = new Set<string>(["flat", "pill"] satisfies BadgeStyleParam[]);
const PROFILE_LAYOUTS = new Set<string>(["default", "compact"] satisfies ProfileLayoutParam[]);
const PROFILE_METRIC_SET = new Set<string>(PROFILE_METRIC_KEYS);
const PROFILE_METRICS_MAX = 8;
const BADGE_LABEL_MAX = 24;

// Default ranges per badge type (contract: `current_streak` and
// `goal_progress` ignore the range parameter entirely).
const BADGE_RANGE_DEFAULTS: Record<BadgeTypeParam, string> = {
  coding_time: "today",
  top_language: "last_7_days",
  current_streak: "last_year",
  goal_progress: "today",
};

// Requested metric data exists but no eligible goal/user resource backs it —
// the public routes answer 404 without caching (data-model privacy rules).
class UnavailableDataError extends Error {}

function notFound(c: Context): Response {
  return c.json({ error: "Not found" }, 404, { "Cache-Control": "no-store" });
}

function badRequest(c: Context, error: string): Response {
  return c.json({ error }, 400, { "Cache-Control": "no-store" });
}

interface PublicUserRow {
  id: string;
  username: string;
  timezone: string;
  timeout: number;
}

interface EmbedTemplateRow {
  id: string;
  name: string;
  template_svg: string;
  created_at: string;
  modified_at: string;
}

class TemplateRenderError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapEmbedTemplate(row: EmbedTemplateRow): EmbedTemplate {
  return {
    id: row.id,
    name: row.name,
    template_svg: row.template_svg,
    created_at: row.created_at,
    modified_at: row.modified_at,
  };
}

async function listEmbedTemplates(db: D1Database, userId: string): Promise<EmbedTemplate[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, template_svg, created_at, modified_at
       FROM embed_templates
       WHERE user_id = ?
       ORDER BY created_at DESC, id DESC`,
    )
    .bind(userId)
    .all<EmbedTemplateRow>();

  return results.map(mapEmbedTemplate);
}

async function loadEmbedTemplate(
  db: D1Database,
  userId: string,
  templateId: string,
): Promise<EmbedTemplate | null> {
  if (templateId.length < 1 || templateId.length > TEMPLATE_ID_MAX) return null;
  const row = await db
    .prepare(
      `SELECT id, name, template_svg, created_at, modified_at
       FROM embed_templates
       WHERE user_id = ? AND id = ?`,
    )
    .bind(userId, templateId)
    .first<EmbedTemplateRow>();

  return row ? mapEmbedTemplate(row) : null;
}

function prepareTemplateInput(
  body: Record<string, unknown>,
): { ok: true; input: EmbedTemplateInput } | { ok: false; error: string } {
  const nameValidation = validateTemplateName(body.name);
  if (!nameValidation.ok) return nameValidation;

  const svgValidation = validateTemplateSvg(body.template_svg);
  if (!svgValidation.ok) return svgValidation;

  return {
    ok: true,
    input: {
      name: (body.name as string).trim(),
      template_svg: body.template_svg as string,
    },
  };
}

function prepareTemplateUpdate(
  existing: EmbedTemplate,
  body: Record<string, unknown>,
): { ok: true; next: EmbedTemplateInput } | { ok: false; error: string } {
  let updates = 0;
  const next: EmbedTemplateInput = {
    name: existing.name,
    template_svg: existing.template_svg,
  };

  if ("name" in body) {
    const nameValidation = validateTemplateName(body.name);
    if (!nameValidation.ok) return nameValidation;
    next.name = (body.name as string).trim();
    updates++;
  }

  if ("template_svg" in body) {
    const svgValidation = validateTemplateSvg(body.template_svg);
    if (!svgValidation.ok) return svgValidation;
    next.template_svg = body.template_svg as string;
    updates++;
  }

  if (updates === 0) {
    return { ok: false, error: "No fields to update" };
  }

  return { ok: true, next };
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
  const templateId = c.req.query("template_id") ?? "";
  if (templateId.length > 0 && (templateId.length > TEMPLATE_ID_MAX || !UUID_RE.test(templateId))) {
    return badRequest(c, "template_id must be a valid UUID");
  }

  const template = templateId.length > 0
    ? await loadEmbedTemplate(c.env.DB, user.id, templateId)
    : null;
  if (templateId.length > 0 && !template) return notFound(c);

  // `metrics` and `layout` apply only to the composite profile card; for
  // other card types they are ignored entirely (public-card contract).
  let profileMetrics: readonly ProfileMetricKey[] = DEFAULT_PROFILE_METRICS;
  let profileLayout: ProfileLayoutParam = "default";
  if (cardType === "profile") {
    const metricsParam = c.req.query("metrics");
    if (metricsParam !== undefined) {
      const parsed = parseProfileMetrics(metricsParam);
      if (!parsed.ok) return badRequest(c, parsed.error);
      profileMetrics = parsed.metrics;
    }
    const layoutParam = c.req.query("layout");
    if (layoutParam !== undefined) {
      if (!PROFILE_LAYOUTS.has(layoutParam)) {
        return badRequest(c, "layout must be one of: default, compact");
      }
      profileLayout = layoutParam as ProfileLayoutParam;
    }
  }

  // Only the built-in profile renderer surfaces goal_progress (the template
  // path renders a fixed non-goal view). Resolve the eligible goal BEFORE the
  // cache so a disabled/edited goal answers 404 (or re-renders) without serving
  // a stale image, and fold its id + modified_at into the cache key.
  let profileGoal: EligibleGoal | null = null;
  if (cardType === "profile" && !template && profileMetrics.includes("goal_progress")) {
    profileGoal = await resolveEligibleGoal(c.env.DB, user.id);
    if (!profileGoal) return notFound(c);
  }

  const ifNoneMatch = c.req.raw.headers.get("If-None-Match");
  // The profile card has no range selector, so its cache entry is range-fixed.
  const cacheRange = cardType === "heatmap" ? "year" : cardType === "profile" ? "profile" : cardRange.key;

  const cacheKey = buildCardCacheKey({
    userId: user.id,
    cardType,
    range: cacheRange,
    theme: themeName,
    templateId,
    templateModifiedAt: template?.modified_at ?? "",
    metrics: cardType === "profile" ? profileMetrics.join("+") : "",
    layout: cardType === "profile" ? profileLayout : "",
    goalModifiedAt: profileGoal ? `${profileGoal.id}:${profileGoal.modifiedAt}` : "",
    v,
    settingsModifiedAt: settings.modified_at ?? "",
  });

  const cached = (await c.env.KV.get(cacheKey, "json")) as CardCacheValue | null;
  if (cached) {
    return svgResponse(cached.svg, cached.etag, settings.freshness_minutes, ifNoneMatch);
  }

  let svg: string;
  try {
    svg = await renderPublicCardSvg(c.env.DB, cardType, user, themeName, cardRange, template, {
      metrics: profileMetrics,
      layout: profileLayout,
      goal: profileGoal,
    });
  } catch (err) {
    if (err instanceof TemplateRenderError) {
      return badRequest(c, err.message);
    }
    if (err instanceof UnavailableDataError) {
      return notFound(c);
    }
    throw err;
  }
  const etag = await computeCardEtag(svg);

  const value: CardCacheValue = { svg, etag, generated_at: new Date().toISOString() };
  await c.env.KV.put(cacheKey, JSON.stringify(value), {
    expirationTtl: cardCacheTtlSeconds(settings.freshness_minutes),
  });

  return svgResponse(svg, etag, settings.freshness_minutes, ifNoneMatch);
});

// ============================================================
// Public badges: /users/{username}/badges/{badge_type}.svg (spec 198)
// Same gate ordering as cards: visibility OFF answers 404 before the
// rate-limit budget, cache lookup, or any aggregate read.
// ============================================================

cardsPublic.get("/users/:username/badges/:file", async (c) => {
  const username = c.req.param("username");
  const file = c.req.param("file");
  if (username.length < 1 || username.length > USERNAME_MAX) {
    return badRequest(c, `username must be 1-${USERNAME_MAX} characters`);
  }
  if (!file.endsWith(".svg")) return notFound(c);
  const badgeType = file.slice(0, -".svg".length);
  if (!BADGE_TYPES.has(badgeType)) return notFound(c);

  const user = await c.env.DB
    .prepare("SELECT id, username, timezone, timeout FROM users WHERE username = ?")
    .bind(username)
    .first<PublicUserRow>();
  if (!user) return notFound(c);

  const settings = await loadEmbedSettings(c.env.DB, user.id);
  if (!settings.enabled) return notFound(c);

  // Badges share the single public-image rate-limit binding with cards. The
  // limiter keys on the truncated client IP (see rate-limit.ts); the
  // `embed-cards:${user.id}` argument is only a log tag, not the rate key.
  // Runs after the OFF gate and before the cache/render work a miss triggers.
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

  // Unsupported enum values are 400 for badges (FR-007) — unlike cards, there
  // is no silent range fallback.
  const badgeRange = resolveBadgeRange(
    c.req.query("range"),
    BADGE_RANGE_DEFAULTS[badgeType as BadgeTypeParam],
  );
  if (!badgeRange) {
    return badRequest(c, "range must be one of: today, last_7_days, last_30_days, last_6_months, last_year, all_time");
  }

  const styleParam = c.req.query("style");
  if (styleParam !== undefined && !BADGE_STYLES.has(styleParam)) {
    return badRequest(c, "style must be one of: flat, pill");
  }
  const style = (styleParam ?? "flat") as BadgeStyleParam;

  const label = c.req.query("label");
  if (label !== undefined && (label.length < 1 || label.length > BADGE_LABEL_MAX)) {
    return badRequest(c, `label must be 1-${BADGE_LABEL_MAX} characters`);
  }

  const goalId = c.req.query("goal_id") ?? "";
  if (goalId.length > 0 && !UUID_RE.test(goalId)) {
    return badRequest(c, "goal_id must be a valid UUID");
  }

  const v = c.req.query("v") ?? "";
  if (v.length > CACHE_BUSTER_MAX) {
    return badRequest(c, `v must be at most ${CACHE_BUSTER_MAX} characters`);
  }

  // Resolve the goal before the cache for goal_progress: an unavailable,
  // disabled, or edited goal must never serve a cached badge image
  // (public-badge contract). The resolved id + modified_at fold into the key.
  let goal: EligibleGoal | null = null;
  if (badgeType === "goal_progress") {
    goal = await resolveEligibleGoal(c.env.DB, user.id, goalId.length > 0 ? goalId : undefined);
    if (!goal) return notFound(c);
  }

  const ifNoneMatch = c.req.raw.headers.get("If-None-Match");
  // Range only fragments the cache for range-aware badges.
  const rangeAware = badgeType === "coding_time" || badgeType === "top_language";
  const cacheKey = buildBadgeCacheKey({
    userId: user.id,
    badgeType,
    range: rangeAware ? badgeRange.key : "",
    theme: themeName,
    style,
    label: label ?? "",
    goalId: goal?.id ?? "",
    goalModifiedAt: goal?.modifiedAt ?? "",
    v,
    settingsModifiedAt: settings.modified_at ?? "",
  });

  const cached = (await c.env.KV.get(cacheKey, "json")) as CardCacheValue | null;
  if (cached) {
    return svgResponse(cached.svg, cached.etag, settings.freshness_minutes, ifNoneMatch);
  }

  const data = await loadBadgeData(c.env.DB, badgeType as BadgeTypeParam, user, badgeRange, goal);

  const svg = renderBadgeSvg({
    label: label ?? data.label,
    value: data.value,
    theme: themeName,
    style,
  });
  const etag = await computeCardEtag(svg);

  const value: CardCacheValue = { svg, etag, generated_at: new Date().toISOString() };
  await c.env.KV.put(cacheKey, JSON.stringify(value), {
    expirationTtl: cardCacheTtlSeconds(settings.freshness_minutes),
  });

  return svgResponse(svg, etag, settings.freshness_minutes, ifNoneMatch);
});

async function loadBadgeData(
  db: D1Database,
  badgeType: BadgeTypeParam,
  user: PublicUserRow,
  badgeRange: NonNullable<ReturnType<typeof resolveBadgeRange>>,
  goal: EligibleGoal | null,
): Promise<BadgeData> {
  if (badgeType === "coding_time") {
    return getCodingTimeBadgeData(db, user.id, user.timezone, user.timeout, badgeRange);
  }
  if (badgeType === "top_language") {
    return getTopLanguageBadgeData(db, user.id, user.timezone, user.timeout, badgeRange);
  }
  if (badgeType === "current_streak") {
    return getCurrentStreakBadgeData(db, user.id, user.timezone, user.timeout);
  }
  // goal_progress: the route resolved and validated the goal before the cache.
  if (!goal) throw new Error("goal_progress badge reached data load without a resolved goal");
  return getGoalProgressBadgeData(db, user.id, user.timezone, goal);
}

function parseProfileMetrics(
  raw: string,
): { ok: true; metrics: ProfileMetricKey[] } | { ok: false; error: string } {
  const entries = raw.split(",");
  if (entries.length < 1 || entries.length > PROFILE_METRICS_MAX) {
    return { ok: false, error: `metrics must contain 1-${PROFILE_METRICS_MAX} entries` };
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!PROFILE_METRIC_SET.has(entry)) {
      return { ok: false, error: `unknown metric: ${entry || "(empty)"}` };
    }
    if (seen.has(entry)) {
      return { ok: false, error: `duplicate metric: ${entry}` };
    }
    seen.add(entry);
  }
  return { ok: true, metrics: entries as ProfileMetricKey[] };
}

async function renderPublicCardSvg(
  db: D1Database,
  cardType: string,
  user: PublicUserRow,
  themeName: string,
  cardRange: CardRange,
  template: EmbedTemplate | null,
  profile: { metrics: readonly ProfileMetricKey[]; layout: ProfileLayoutParam; goal: EligibleGoal | null },
): Promise<string> {
  if (cardType === "profile") {
    if (template) {
      // Template placeholders are a fixed vocabulary, so the template path
      // renders a fixed profile view: trailing-week totals plus streak stats.
      // The `metrics` selection only affects the built-in renderer.
      const summary = await getSummaryCardData(db, user.id, user.timezone, user.timeout, 7);
      const streak = await getStreakData(db, user.id, user.timezone, user.timeout);
      const rendered = renderTemplateSvg(template.template_svg, defaultTemplateValues({
        username: user.username,
        card_type: cardType,
        range: "the last 7 days",
        theme: themeName,
        total_time: formatHumanReadable(summary.totalSeconds),
        daily_average: formatHumanReadable(summary.dailyAverageSeconds),
        best_day: summary.bestDay
          ? `${summary.bestDay.date} / ${formatHumanReadable(summary.bestDay.seconds)}`
          : "No activity",
        top_language: summary.topLanguage
          ? `${summary.topLanguage.language} / ${formatTemplatePercent(summary.topLanguage.percent)}`
          : "No language",
        current_streak: formatDays(streak.currentStreak),
        longest_streak: formatDays(streak.longestStreak),
        tracked_days: formatDays(streak.trackedDays),
      }));
      if (!rendered.ok) throw new TemplateRenderError(rendered.error);
      return rendered.svg;
    }
    const sections = await getProfileCardData(db, user.id, user.timezone, user.timeout, profile.metrics, profile.goal);
    if (!sections) throw new UnavailableDataError("no eligible goal");
    return renderProfileCardSvg({
      username: user.username,
      sections,
      theme: themeName,
      layout: profile.layout,
    });
  }

  if (cardType === "heatmap") {
    const data = await getHeatmapData(db, user.id, user.timezone, user.timeout);
    if (template) {
      const rendered = renderTemplateSvg(template.template_svg, defaultTemplateValues({
        username: user.username,
        card_type: cardType,
        range: "the last year",
        theme: themeName,
        total_time: formatHumanReadable(data.totalSeconds),
      }));
      if (!rendered.ok) throw new TemplateRenderError(rendered.error);
      return rendered.svg;
    }
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
    if (template) {
      const rendered = renderTemplateSvg(template.template_svg, defaultTemplateValues({
        username: user.username,
        card_type: cardType,
        range: cardRange.label,
        theme: themeName,
        total_time: formatHumanReadable(data.totalSeconds),
        current_streak: formatDays(data.currentStreak),
        longest_streak: formatDays(data.longestStreak),
        tracked_days: formatDays(data.trackedDays),
      }));
      if (!rendered.ok) throw new TemplateRenderError(rendered.error);
      return rendered.svg;
    }
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
    if (template) {
      const rendered = renderTemplateSvg(template.template_svg, summaryTemplateValues(
        user.username,
        cardType,
        themeName,
        cardRange.label,
        data.totalSeconds,
        data.dailyAverageSeconds,
        data.bestDay,
        data.topLanguage,
      ));
      if (!rendered.ok) throw new TemplateRenderError(rendered.error);
      return rendered.svg;
    }
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
    if (template) {
      const topLanguage = data.languages[0] ?? null;
      const rendered = renderTemplateSvg(template.template_svg, defaultTemplateValues({
        username: user.username,
        card_type: cardType,
        range: cardRange.label,
        theme: themeName,
        total_time: formatHumanReadable(data.totalSeconds),
        top_language: topLanguage
          ? `${topLanguage.language} / ${formatTemplatePercent(topLanguage.percent)}`
          : "No language",
        languages: data.languages.length > 0
          ? data.languages.map((item) => `${item.language} ${formatTemplatePercent(item.percent)}`).join(", ")
          : "No language data",
      }));
      if (!rendered.ok) throw new TemplateRenderError(rendered.error);
      return rendered.svg;
    }
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

function summaryTemplateValues(
  username: string,
  cardType: string,
  themeName: string,
  rangeLabel: string,
  totalSeconds: number,
  dailyAverageSeconds: number,
  bestDay: { date: string; seconds: number } | null,
  topLanguage: { language: string; seconds: number; percent: number } | null,
): CardTemplateValues {
  return defaultTemplateValues({
    username,
    card_type: cardType,
    range: rangeLabel,
    theme: themeName,
    total_time: formatHumanReadable(totalSeconds),
    daily_average: formatHumanReadable(dailyAverageSeconds),
    best_day: bestDay
      ? `${bestDay.date} / ${formatHumanReadable(bestDay.seconds)}`
      : "No activity",
    top_language: topLanguage
      ? `${topLanguage.language} / ${formatTemplatePercent(topLanguage.percent)}`
      : "No language",
  });
}

function svgResponse(
  svg: string,
  etag: string,
  freshnessMinutes: number,
  ifNoneMatch: string | null,
): Response {
  const cacheControl = cardCacheControl(freshnessMinutes);
  const headers = svgResponseHeaders(cacheControl, etag);
  if (ifNoneMatch && etagMatches(ifNoneMatch, etag)) {
    return new Response(null, {
      status: 304,
      headers,
    });
  }
  return new Response(svg, {
    status: 200,
    headers,
  });
}

function svgResponseHeaders(cacheControl: string, etag: string): HeadersInit {
  return {
    "Content-Type": "image/svg+xml; charset=utf-8",
    "Cache-Control": cacheControl,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  };
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
