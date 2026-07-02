import { describe, expect, it } from "vitest";
import {
  escapeXml,
  renderHeatmapSvg,
  renderStreakSvg,
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
    expect(svg).toContain("Coding streaks in the last 7 days");
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
});

describe("escapeXml", () => {
  it("escapes the five XML entities", () => {
    expect(escapeXml("<>&'\"")).toBe("&lt;&gt;&amp;&apos;&quot;");
  });
});
