export type ProfileCardType = "heatmap" | "summary" | "languages" | "streak";

export interface ProfileCardSnippet {
  cardType: ProfileCardType;
  label: string;
  altText: string;
  url: string;
  markdown: string;
}

const PROFILE_CARD_TYPES: Array<{ cardType: ProfileCardType; label: string; altText: string }> = [
  { cardType: "heatmap", label: "Heatmap", altText: "CloudTime heatmap" },
  { cardType: "summary", label: "Summary", altText: "CloudTime summary" },
  { cardType: "languages", label: "Languages", altText: "CloudTime languages" },
  { cardType: "streak", label: "Streak", altText: "CloudTime streak" },
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
