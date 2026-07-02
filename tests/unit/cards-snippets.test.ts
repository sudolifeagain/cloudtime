import { describe, expect, it } from "vitest";
import { buildProfileCardSnippets, buildProfileCardUrl } from "../../src/utils/cards/snippets";

describe("profile card snippets", () => {
  it("builds GitHub README image markdown for available public cards", () => {
    const snippets = buildProfileCardSnippets({
      apiBaseUrl: "https://cloudtime.example.test/api/v1/",
      username: "alice",
      theme: "default",
    });

    expect(snippets.map((snippet) => snippet.cardType)).toEqual(["heatmap", "summary", "languages", "streak"]);
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
      "![CloudTime streak](https://cloudtime.example.test/api/v1/users/alice/cards/streak.svg?theme=default)",
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
