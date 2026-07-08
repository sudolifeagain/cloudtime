import { describe, expect, it } from "vitest";
import {
  buildProfileBadgeSnippets,
  buildProfileBadgeUrl,
  buildProfileCardSnippets,
  buildProfileCardUrl,
} from "../../src/utils/cards/snippets";

describe("profile card snippets", () => {
  it("builds GitHub README image markdown for available public cards", () => {
    const snippets = buildProfileCardSnippets({
      apiBaseUrl: "https://cloudtime.example.test/api/v1/",
      username: "alice",
      theme: "default",
    });

    expect(snippets.map((snippet) => snippet.cardType)).toEqual([
      "heatmap",
      "summary",
      "languages",
      "streak",
      "profile",
    ]);
    expect(snippets[0].markdown).toBe(
      "![CloudTime heatmap](https://cloudtime.example.test/api/v1/users/alice/cards/heatmap.svg?theme=default)",
    );
    expect(snippets[1].markdown).toBe(
      "![CloudTime summary](https://cloudtime.example.test/api/v1/users/alice/cards/summary.svg?theme=default)",
    );
    expect(snippets[2].markdown).toBe(
      "![CloudTime languages](https://cloudtime.example.test/api/v1/users/alice/cards/languages.svg?theme=default)",
    );
    expect(snippets[3].markdown).toBe(
      "![CloudTime coding activity streak](https://cloudtime.example.test/api/v1/users/alice/cards/streak.svg?theme=default)",
    );
    expect(snippets[4].markdown).toBe(
      "![CloudTime profile card](https://cloudtime.example.test/api/v1/users/alice/cards/profile.svg?theme=default)",
    );
  });

  it("encodes usernames and never includes authentication material", () => {
    const url = buildProfileCardUrl({
      apiBaseUrl: "https://cloudtime.example.test/api/v1",
      username: "alice@example",
      cardType: "heatmap",
      theme: "default",
      v: "20260703",
    });

    expect(url).toBe(
      "https://cloudtime.example.test/api/v1/users/alice%40example/cards/heatmap.svg?theme=default&v=20260703",
    );
    expect(url).not.toContain("api_key");
    expect(url).not.toContain("__Host-session");
    expect(url).not.toContain("Authorization");
  });
});

describe("profile badge snippets", () => {
  it("builds badge markdown with meaningful alt text for every badge type", () => {
    const snippets = buildProfileBadgeSnippets({
      apiBaseUrl: "https://cloudtime.example.test/api/v1",
      username: "alice",
      theme: "default",
    });

    expect(snippets.map((snippet) => snippet.badgeType)).toEqual([
      "coding_time",
      "top_language",
      "current_streak",
      "goal_progress",
    ]);
    expect(snippets[0].markdown).toBe(
      "![CloudTime coding time today](https://cloudtime.example.test/api/v1/users/alice/badges/coding_time.svg?range=today&theme=default)",
    );
    expect(snippets[1].markdown).toBe(
      "![CloudTime top language in the last 7 days](https://cloudtime.example.test/api/v1/users/alice/badges/top_language.svg?range=last_7_days&theme=default)",
    );
    expect(snippets[2].markdown).toBe(
      "![CloudTime current coding streak](https://cloudtime.example.test/api/v1/users/alice/badges/current_streak.svg?theme=default)",
    );
    expect(snippets[3].markdown).toBe(
      "![CloudTime goal progress](https://cloudtime.example.test/api/v1/users/alice/badges/goal_progress.svg?theme=default)",
    );

    // Alt text is the accessibility contract (FR-015): meaningful and present.
    for (const snippet of snippets) {
      expect(snippet.altText.length).toBeGreaterThan(0);
      expect(snippet.markdown.startsWith(`![${snippet.altText}](`)).toBe(true);
    }
  });

  it("encodes usernames and never includes authentication material", () => {
    const url = buildProfileBadgeUrl({
      apiBaseUrl: "https://cloudtime.example.test/api/v1/",
      username: "alice@example",
      badgeType: "coding_time",
      theme: "dark",
      range: "today",
      v: "20260708",
    });

    expect(url).toBe(
      "https://cloudtime.example.test/api/v1/users/alice%40example/badges/coding_time.svg?range=today&theme=dark&v=20260708",
    );
    expect(url).not.toContain("api_key");
    expect(url).not.toContain("__Host-session");
    expect(url).not.toContain("Authorization");
  });
});
