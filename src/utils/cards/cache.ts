// Cache helpers for rendered embeddable cards (spec 160).
//
// Public cards are served cache-first from KV. The cache key folds in every
// option that changes the rendered bytes plus the settings `modified_at`, so a
// visibility/theme/freshness change invalidates old entries without an explicit
// purge. The caller-supplied `v` participates in the key only (FR-015) — it
// never selects data or affects authorization.

import { sha256Hex } from "../crypto";

export interface CardCacheValue {
  svg: string;
  etag: string;
  generated_at: string;
}

export interface CardCacheKeyParts {
  userId: string;
  cardType: string;
  range: string;
  theme: string;
  templateId: string;
  templateModifiedAt?: string;
  /** Normalized metric list for the `profile` composite card; empty otherwise. */
  metrics?: string;
  /** Normalized layout for the `profile` composite card; empty otherwise. */
  layout?: string;
  /**
   * `<goalId>:<goal.modified_at>` of the eligible goal when the profile card's
   * metrics include `goal_progress`; empty otherwise. Folding it in means a
   * disabled/edited goal invalidates the warm card immediately.
   */
  goalModifiedAt?: string;
  v: string;
  settingsModifiedAt: string;
}

export function buildCardCacheKey(p: CardCacheKeyParts): string {
  return [
    "embed-card",
    p.userId,
    p.cardType,
    p.range,
    p.theme,
    p.templateId,
    p.templateModifiedAt ?? "",
    p.metrics ?? "",
    p.layout ?? "",
    p.goalModifiedAt ?? "",
    p.v,
    p.settingsModifiedAt,
  ].join(":");
}

export interface BadgeCacheKeyParts {
  userId: string;
  badgeType: string;
  range: string;
  theme: string;
  style: string;
  label: string;
  /** Resolved goal id for `goal_progress` badges; empty otherwise. */
  goalId: string;
  /**
   * `modified_at` of the resolved goal for `goal_progress` badges; empty
   * otherwise. Folding it in invalidates a warm badge when the goal is edited.
   */
  goalModifiedAt?: string;
  v: string;
  settingsModifiedAt: string;
}

// Badges live under their own prefix so badge and card entries never collide.
// The free-text label is URI-encoded so a crafted label cannot alias another
// option combination's key segments.
export function buildBadgeCacheKey(p: BadgeCacheKeyParts): string {
  return [
    "embed-badge",
    p.userId,
    p.badgeType,
    p.range,
    p.theme,
    p.style,
    encodeURIComponent(p.label),
    p.goalId,
    p.goalModifiedAt ?? "",
    p.v,
    p.settingsModifiedAt,
  ].join(":");
}

// Translate the per-user freshness window into a Cache-Control directive. Used
// for both the response header (so GitHub's image proxy refetches on cadence)
// and the KV TTL. Clamped to a 60s floor so a misconfigured 0 cannot disable
// caching entirely and hammer the origin.
export function cardCacheTtlSeconds(freshnessMinutes: number): number {
  const minutes = Number.isFinite(freshnessMinutes) ? freshnessMinutes : 15;
  return Math.max(60, Math.floor(minutes * 60));
}

export function cardCacheControl(freshnessMinutes: number): string {
  const sec = cardCacheTtlSeconds(freshnessMinutes);
  return `public, max-age=${sec}, s-maxage=${sec}`;
}

// Strong ETag derived from the exact rendered bytes.
export async function computeCardEtag(svg: string): Promise<string> {
  const hash = await sha256Hex(svg);
  return `"${hash.slice(0, 32)}"`;
}
