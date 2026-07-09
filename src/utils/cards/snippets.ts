export type ProfileCardType = "heatmap" | "summary" | "languages" | "streak" | "profile";
export type ProfileBadgeType = "coding_time" | "top_language" | "current_streak" | "goal_progress";

export interface ProfileCardSnippet {
  cardType: ProfileCardType;
  label: string;
  altText: string;
  url: string;
  markdown: string;
}

export interface ProfileBadgeSnippet {
  badgeType: ProfileBadgeType;
  label: string;
  altText: string;
  url: string;
  markdown: string;
}

const PROFILE_CARD_TYPES: Array<{ cardType: ProfileCardType; label: string; altText: string }> = [
  { cardType: "heatmap", label: "Heatmap", altText: "CloudTime heatmap" },
  { cardType: "summary", label: "Summary", altText: "CloudTime summary" },
  { cardType: "languages", label: "Languages", altText: "CloudTime languages" },
  { cardType: "streak", label: "Streak", altText: "CloudTime coding activity streak" },
  { cardType: "profile", label: "Profile card", altText: "CloudTime profile card" },
];

const PROFILE_BADGE_TYPES: Array<{
  badgeType: ProfileBadgeType;
  label: string;
  altText: string;
  range?: string;
}> = [
  { badgeType: "coding_time", label: "Coding time badge", altText: "CloudTime coding time today", range: "today" },
  { badgeType: "top_language", label: "Top language badge", altText: "CloudTime top language in the last 7 days", range: "last_7_days" },
  { badgeType: "current_streak", label: "Current streak badge", altText: "CloudTime current coding streak" },
  { badgeType: "goal_progress", label: "Goal progress badge", altText: "CloudTime goal progress" },
];

export function buildProfileCardSnippets({
  apiBaseUrl,
  username,
  theme,
}: {
  apiBaseUrl: string;
  username: string;
  theme: string;
}): ProfileCardSnippet[] {
  return PROFILE_CARD_TYPES.map((card) => {
    const url = buildProfileCardUrl({
      apiBaseUrl,
      username,
      cardType: card.cardType,
      theme,
    });
    return {
      ...card,
      url,
      markdown: `![${card.altText}](${url})`,
    };
  });
}

export function buildProfileCardUrl({
  apiBaseUrl,
  username,
  cardType,
  theme,
  v,
}: {
  apiBaseUrl: string;
  username: string;
  cardType: ProfileCardType;
  theme: string;
  v?: string;
}): string {
  const params = new URLSearchParams({ theme });
  if (v) params.set("v", v);
  return `${apiBaseUrl.replace(/\/+$/, "")}/users/${encodeURIComponent(username)}/cards/${cardType}.svg?${params.toString()}`;
}

export function buildProfileBadgeSnippets({
  apiBaseUrl,
  username,
  theme,
}: {
  apiBaseUrl: string;
  username: string;
  theme: string;
}): ProfileBadgeSnippet[] {
  return PROFILE_BADGE_TYPES.map((badge) => {
    const url = buildProfileBadgeUrl({
      apiBaseUrl,
      username,
      badgeType: badge.badgeType,
      theme,
      range: badge.range,
    });
    return {
      badgeType: badge.badgeType,
      label: badge.label,
      altText: badge.altText,
      url,
      markdown: `![${badge.altText}](${url})`,
    };
  });
}

export function buildProfileBadgeUrl({
  apiBaseUrl,
  username,
  badgeType,
  theme,
  range,
  v,
}: {
  apiBaseUrl: string;
  username: string;
  badgeType: ProfileBadgeType;
  theme: string;
  range?: string;
  v?: string;
}): string {
  const params = new URLSearchParams();
  if (range) params.set("range", range);
  params.set("theme", theme);
  if (v) params.set("v", v);
  return `${apiBaseUrl.replace(/\/+$/, "")}/users/${encodeURIComponent(username)}/badges/${badgeType}.svg?${params.toString()}`;
}
