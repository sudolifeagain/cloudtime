import { describe, expect, it } from "vitest";
import {
  escapeXml,
  renderHeatmapSvg,
  renderLanguagesSvg,
  renderStreakSvg,
  renderSummarySvg,
  resolveTheme,
  resolveThemeName,
} from "../../src/utils/cards/render";

const TODAY = "2026-06-18";

describe("renderHeatmapSvg", () => {
  it("produces a well-formed svg root with an image role", () => {
    const svg = renderHeatmapSvg({
      username: "alice",
      dayTotals: new Map(),
      todayStr: TODAY,
      totalSeconds: 0,
    });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('role="img"');
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("renders a zero-activity user without throwing", () => {
    const svg = renderHeatmapSvg({
      username: "alice",
      dayTotals: new Map(),
      todayStr: TODAY,
      totalSeconds: 0,
    });
    expect(svg).toContain("0 secs in the last year");
  });

  it("escapes the username to prevent markup injection", () => {
    const svg = renderHeatmapSvg({
      username: '<script>evil()</script>&"x',
      dayTotals: new Map(),
      todayStr: TODAY,
      totalSeconds: 0,
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("colors a high-activity day with the darkest level and a title", () => {
    const day = "2026-06-17";
    const svg = renderHeatmapSvg({
      username: "a",
      dayTotals: new Map([[day, 8 * 3600]]),
      todayStr: TODAY,
      totalSeconds: 8 * 3600,
    });
    expect(svg).toContain("#216e39");
    expect(svg).toContain(`<title>${day}: 8 hrs`);
  });

  it("does not crowd adjacent month labels at the range boundary", () => {
    const svg = renderHeatmapSvg({
      username: "alice",
      dayTotals: new Map(),
      todayStr: "2026-07-04",
      totalSeconds: 0,
    });
    const firstMonthLabel = svg.match(/<text x="\d+" y="26" class="lbl">([A-Z][a-z]{2})<\/text>/)?.[1];
    expect(firstMonthLabel).toBe("Jul");
  });

  it("emits only a safe static subset (no script/foreignObject/href)", () => {
    const svg = renderHeatmapSvg({
      username: "a",
      dayTotals: new Map([["2026-06-17", 3600]]),
      todayStr: TODAY,
      totalSeconds: 3600,
    });
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/foreignObject/i);
    expect(svg).not.toMatch(/href=/i);
    expect(svg).not.toMatch(/on\w+=/i); // no event-handler attributes
  });
});

describe("renderSummarySvg", () => {
  it("renders summary metrics and escapes language text", () => {
    const svg = renderSummarySvg({
      username: "alice",
      totalSeconds: 3 * 3600,
      dailyAverageSeconds: 1800,
      bestDay: { date: "2026-06-17", seconds: 2 * 3600 },
      topLanguage: { language: '<script>TypeScript</script>', seconds: 7200, percent: 66.7 },
      rangeLabel: "the last 7 days",
    });

    expect(svg).toContain("Coding summary in the last 7 days");
    expect(svg).toContain("3 hrs");
    expect(svg).toContain("30 mins");
    expect(svg).toContain("2026-06-17 / 2 hrs");
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("emits only a safe static subset", () => {
    const svg = renderSummarySvg({
      username: "a",
      totalSeconds: 0,
      dailyAverageSeconds: 0,
      bestDay: null,
      topLanguage: null,
    });
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/foreignObject/i);
    expect(svg).not.toMatch(/href=/i);
    expect(svg).not.toMatch(/on\w+=/i);
  });
});

describe("renderLanguagesSvg", () => {
  it("renders language shares and zero activity states", () => {
    const svg = renderLanguagesSvg({
      username: "alice",
      totalSeconds: 3 * 3600,
      languages: [
        { language: "TypeScript", seconds: 7200, percent: 66.7 },
        { language: "Markdown", seconds: 3600, percent: 33.3 },
      ],
      rangeLabel: "the last 30 days",
    });

    expect(svg).toContain("Top languages in the last 30 days");
    expect(svg).toContain("TypeScript");
    expect(svg).toContain("67%");
    expect(svg).toContain("Markdown");
    expect(svg).toContain("33%");

    const empty = renderLanguagesSvg({
      username: "alice",
      totalSeconds: 0,
      languages: [],
    });
    expect(empty).toContain("No language data in the last year");
  });

  it("escapes language names and emits only a safe static subset", () => {
    const svg = renderLanguagesSvg({
      username: "a",
      totalSeconds: 60,
      languages: [{ language: '<script>x</script>', seconds: 60, percent: 100 }],
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toMatch(/foreignObject/i);
    expect(svg).not.toMatch(/href=/i);
    expect(svg).not.toMatch(/on\w+=/i);
  });
});

describe("renderStreakSvg", () => {
  it("produces a well-formed svg root with an image role", () => {
    const svg = renderStreakSvg({
      username: "alice",
      currentStreak: 0,
      longestStreak: 0,
      trackedDays: 0,
      totalSeconds: 0,
    });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('role="img"');
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("renders a zero-activity user without throwing", () => {
    const svg = renderStreakSvg({
      username: "alice",
      currentStreak: 0,
      longestStreak: 0,
      trackedDays: 0,
      totalSeconds: 0,
    });
    expect(svg).toContain("0 days");
    expect(svg).toContain("0 secs total coding time");
  });

  it("renders the normalized range label", () => {
    const svg = renderStreakSvg({
      username: "alice",
      currentStreak: 2,
      longestStreak: 4,
      trackedDays: 5,
      totalSeconds: 3600,
      rangeLabel: "the last 7 days",
    });
    expect(svg).toContain("CloudTime coding activity streaks in the last 7 days");
  });

  it("escapes the username to prevent markup injection", () => {
    const svg = renderStreakSvg({
      username: '<script>evil()</script>&"x',
      currentStreak: 1,
      longestStreak: 1,
      trackedDays: 1,
      totalSeconds: 60,
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("emits only a safe static subset (no script/foreignObject/href)", () => {
    const svg = renderStreakSvg({
      username: "a",
      currentStreak: 3,
      longestStreak: 5,
      trackedDays: 12,
      totalSeconds: 3600,
    });
    expect(svg).not.toMatch(/<script/i);
    expect(svg).not.toMatch(/foreignObject/i);
    expect(svg).not.toMatch(/href=/i);
    expect(svg).not.toMatch(/on\w+=/i);
  });
});

describe("theme resolution", () => {
  it("falls back to the default theme for an unknown name", () => {
    expect(resolveThemeName("does-not-exist")).toBe("default");
    expect(resolveTheme("does-not-exist")).toBe(resolveTheme("default"));
  });

  it("keeps a known theme name", () => {
    expect(resolveThemeName("default")).toBe("default");
  });

  it("supports the dark built-in theme", () => {
    expect(resolveThemeName("dark")).toBe("dark");
    expect(resolveTheme("dark").background).toBe("#0d1117");
  });
});

describe("escapeXml", () => {
  it("escapes the five XML entities", () => {
    expect(escapeXml("<>&'\"")).toBe("&lt;&gt;&amp;&apos;&quot;");
  });
});
