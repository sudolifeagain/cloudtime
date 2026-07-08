import { describe, expect, it } from "vitest";
import {
  escapeXml,
  renderBadgeSvg,
  renderHeatmapSvg,
  renderLanguagesSvg,
  renderProfileCardSvg,
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

describe("renderBadgeSvg", () => {
  it("produces a well-formed svg root with an accessible image name", () => {
    const svg = renderBadgeSvg({ label: "today", value: "2 hrs" });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="CloudTime today: 2 hrs"');
    expect(svg).toContain(">today</text>");
    expect(svg).toContain(">2 hrs</text>");
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("renders flat corners by default and full rounding for pill", () => {
    const flat = renderBadgeSvg({ label: "streak", value: "3 days" });
    expect(flat).toContain('rx="3"');
    const pill = renderBadgeSvg({ label: "streak", value: "3 days", style: "pill" });
    expect(pill).toContain('rx="12"');
  });

  it("grows the badge width with longer text", () => {
    const short = renderBadgeSvg({ label: "goal", value: "50%" });
    const long = renderBadgeSvg({ label: "goal", value: "1 hr 30 mins of 3 hrs" });
    const width = (svg: string) => Number(/width="(\d+)"/.exec(svg)?.[1]);
    expect(width(long)).toBeGreaterThan(width(short));
  });

  it("applies built-in themes", () => {
    const dark = renderBadgeSvg({ label: "today", value: "1 hr", theme: "dark" });
    expect(dark).toContain("#0d1117");
  });

  it("escapes label and value and emits only a safe static subset", () => {
    const svg = renderBadgeSvg({ label: '<script>x</script>', value: '"&<>' });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toMatch(/foreignObject/i);
    expect(svg).not.toMatch(/href=/i);
    expect(svg).not.toMatch(/on\w+=/i);
  });
});

describe("renderProfileCardSvg", () => {
  const SECTIONS = [
    { label: "Today", value: "2 hrs" },
    { label: "Last 7 days", value: "10 hrs" },
    { label: "Top language", value: "TypeScript / 67%" },
    { label: "Current streak", value: "3 days" },
  ];

  it("renders requested sections in order with an accessible name", () => {
    const svg = renderProfileCardSvg({ username: "alice", sections: SECTIONS });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('role="img"');
    expect(svg).toContain(
      'aria-label="CloudTime profile card for alice: Today, Last 7 days, Top language, Current streak"',
    );
    for (const section of SECTIONS) {
      expect(svg).toContain(section.label);
      expect(svg).toContain(escapeXml(section.value));
    }
    expect(svg.indexOf("Today")).toBeLessThan(svg.indexOf("Last 7 days"));
    expect(svg.indexOf("Last 7 days")).toBeLessThan(svg.indexOf("Top language"));
  });

  it("renders the compact layout narrower than the default layout", () => {
    const dflt = renderProfileCardSvg({ username: "alice", sections: SECTIONS });
    const compact = renderProfileCardSvg({ username: "alice", sections: SECTIONS, layout: "compact" });
    expect(dflt).toContain('width="495"');
    expect(compact).toContain('width="320"');
    for (const section of SECTIONS) {
      expect(compact).toContain(section.label);
    }
  });

  it("grows the default layout height with more rows", () => {
    const height = (svg: string) => Number(/height="(\d+)"/.exec(svg)?.[1]);
    const two = renderProfileCardSvg({ username: "a", sections: SECTIONS.slice(0, 2) });
    const six = renderProfileCardSvg({
      username: "a",
      sections: [...SECTIONS, { label: "All time", value: "300 hrs" }, { label: "Goal progress", value: "50% of 2 hrs / day" }],
    });
    expect(height(six)).toBeGreaterThan(height(two));
  });

  it("applies built-in themes", () => {
    const dark = renderProfileCardSvg({ username: "alice", sections: SECTIONS, theme: "dark" });
    expect(dark).toContain("#0d1117");
  });

  it("escapes user-derived text and emits only a safe static subset", () => {
    const svg = renderProfileCardSvg({
      username: '<script>evil()</script>',
      sections: [{ label: "Top language", value: '<script>TS</script>' }],
    });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).not.toMatch(/foreignObject/i);
    expect(svg).not.toMatch(/href=/i);
    expect(svg).not.toMatch(/on\w+=/i);
  });
});

describe("escapeXml", () => {
  it("escapes the five XML entities", () => {
    expect(escapeXml("<>&'\"")).toBe("&lt;&gt;&amp;&apos;&quot;");
  });
});
