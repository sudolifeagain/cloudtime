// Built-in SVG renderers for embeddable cards (spec 160).
//
// SVG is produced as plain strings (no rendering dependency) to stay within the
// Workers CPU budget. All user-derived text is XML-escaped. Output is a safe
// static subset: no scripts, event handlers, foreignObject, or external
// references — see FR-016/FR-017.

import { formatHumanReadable } from "../time-format";

export interface CardTheme {
  background: string;
  border: string;
  cellEmpty: string;
  accent: string;
  levels: [string, string, string, string];
  text: string;
  subtext: string;
}

export const THEMES: Record<string, CardTheme> = {
  default: {
    background: "#ffffff",
    border: "#d0d7de",
    cellEmpty: "#ebedf0",
    accent: "#30a14e",
    levels: ["#9be9a8", "#40c463", "#30a14e", "#216e39"],
    text: "#1f2328",
    subtext: "#656d76",
  },
  dark: {
    background: "#0d1117",
    border: "#30363d",
    cellEmpty: "#161b22",
    accent: "#2f81f7",
    levels: ["#0e4429", "#006d32", "#26a641", "#39d353"],
    text: "#e6edf3",
    subtext: "#8b949e",
  },
};

export function resolveTheme(name?: string): CardTheme {
  if (name && Object.prototype.hasOwnProperty.call(THEMES, name)) return THEMES[name];
  return THEMES.default;
}

// Normalized theme name for cache keys: unknown names collapse to "default" so
// they share the default-theme cache entry rather than fragmenting it.
export function resolveThemeName(name?: string): string {
  return name && Object.prototype.hasOwnProperty.call(THEMES, name) ? name : "default";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_LABELS: Array<[number, string]> = [[1, "Mon"], [3, "Wed"], [5, "Fri"]];

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (ch) => {
    switch (ch) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case "'": return "&apos;";
      default: return "&quot;";
    }
  });
}

// Fixed coding-time thresholds (seconds) → intensity level 0-4.
function levelFor(seconds: number): number {
  if (seconds <= 0) return 0;
  if (seconds < 1800) return 1; // < 30 min
  if (seconds < 3600) return 2; // < 1 h
  if (seconds < 7200) return 3; // < 2 h
  return 4;
}

export interface HeatmapRenderOptions {
  username: string;
  dayTotals: Map<string, number>;
  todayStr: string;
  totalSeconds: number;
  theme?: string;
}

export interface StreakRenderOptions {
  username: string;
  currentStreak: number;
  longestStreak: number;
  trackedDays: number;
  totalSeconds: number;
  theme?: string;
  rangeLabel?: string;
}

export interface SummaryRenderOptions {
  username: string;
  totalSeconds: number;
  dailyAverageSeconds: number;
  bestDay: { date: string; seconds: number } | null;
  topLanguage: { language: string; seconds: number; percent: number } | null;
  theme?: string;
  rangeLabel?: string;
}

export interface LanguagesRenderOptions {
  username: string;
  totalSeconds: number;
  languages: Array<{ language: string; seconds: number; percent: number }>;
  theme?: string;
  rangeLabel?: string;
}

export function renderHeatmapSvg(opts: HeatmapRenderOptions): string {
  const theme = resolveTheme(opts.theme);
  const [ty, tm, td] = opts.todayStr.split("-").map(Number);
  const today = new Date(Date.UTC(ty, tm - 1, td));
  const todayDow = today.getUTCDay(); // 0=Sun..6=Sat
  const WEEKS = 53;
  const totalDays = (WEEKS - 1) * 7 + todayDow + 1;
  const startMs = today.getTime() - (totalDays - 1) * 86400000;

  const CELL = 11;
  const GAP = 2;
  const STEP = CELL + GAP;
  const LEFT = 30;
  const TOP = 34;
  const gridH = 7 * STEP;
  const width = LEFT + WEEKS * STEP + 14;
  const height = TOP + gridH + 30;

  let cells = "";
  let monthLabels = "";
  let lastMonth = -1;
  for (let i = 0; i < totalDays; i++) {
    const dt = new Date(startMs + i * 86400000);
    const dateStr = `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
    const col = Math.floor(i / 7);
    const row = dt.getUTCDay();
    const secs = opts.dayTotals.get(dateStr) ?? 0;
    const lvl = levelFor(secs);
    const fill = lvl === 0 ? theme.cellEmpty : theme.levels[lvl - 1];
    const x = LEFT + col * STEP;
    const y = TOP + row * STEP;
    cells += `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" ry="2" fill="${fill}"><title>${dateStr}: ${escapeXml(formatHumanReadable(secs))}</title></rect>`;
    if (row === 0) {
      const month = dt.getUTCMonth();
      if (month !== lastMonth) {
        lastMonth = month;
        monthLabels += `<text x="${x}" y="${TOP - 8}" class="lbl">${MONTHS[month]}</text>`;
      }
    }
  }

  let dayLabels = "";
  for (const [row, label] of DAY_LABELS) {
    const y = TOP + row * STEP + CELL - 1;
    dayLabels += `<text x="2" y="${y}" class="lbl">${label}</text>`;
  }

  const legendY = TOP + gridH + 16;
  const swatches = [theme.cellEmpty, ...theme.levels];
  let legend = `<text x="${width - 152}" y="${legendY}" class="lbl">Less</text>`;
  for (let i = 0; i < swatches.length; i++) {
    const x = width - 124 + i * (CELL + 2);
    legend += `<rect x="${x}" y="${legendY - 9}" width="${CELL}" height="${CELL}" rx="2" ry="2" fill="${swatches[i]}"/>`;
  }
  legend += `<text x="${width - 124 + swatches.length * (CELL + 2) + 4}" y="${legendY}" class="lbl">More</text>`;

  const title = `@${escapeXml(opts.username)}`;
  const totalText = escapeXml(`${formatHumanReadable(opts.totalSeconds)} in the last year`);
  const ariaLabel = escapeXml(`Coding activity heatmap for ${opts.username}`);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${ariaLabel}">` +
    `<style>text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;}` +
    `.title{font-size:13px;font-weight:600;fill:${theme.text};}` +
    `.total{font-size:11px;fill:${theme.subtext};}` +
    `.lbl{font-size:9px;fill:${theme.subtext};}</style>` +
    `<rect width="100%" height="100%" fill="${theme.background}"/>` +
    `<text x="2" y="16" class="title">${title}</text>` +
    `<text x="${width - 14}" y="16" text-anchor="end" class="total">${totalText}</text>` +
    monthLabels +
    dayLabels +
    cells +
    legend +
    `</svg>`
  );
}

export function renderSummarySvg(opts: SummaryRenderOptions): string {
  const theme = resolveTheme(opts.theme);
  const width = 495;
  const height = 195;
  const cardPadding = 22;
  const rangeLabel = escapeXml(opts.rangeLabel ?? "the last year");
  const title = `@${escapeXml(truncateText(opts.username, 38))}`;
  const ariaLabel = escapeXml(`Coding summary card for ${opts.username}`);
  const bestDayText = opts.bestDay
    ? `${opts.bestDay.date} / ${formatHumanReadable(opts.bestDay.seconds)}`
    : "No activity";
  const topLanguageText = opts.topLanguage
    ? `${truncateText(opts.topLanguage.language, 18)} / ${formatPercent(opts.topLanguage.percent)}`
    : "No language";

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${ariaLabel}">` +
    cardStyle(theme) +
    `<rect width="100%" height="100%" rx="8" ry="8" fill="${theme.background}" stroke="${theme.border}"/>` +
    `<text x="${cardPadding}" y="31" class="title">${title}</text>` +
    `<text x="${cardPadding}" y="52" class="subtitle">Coding summary in ${rangeLabel}</text>` +
    renderSummaryMetric(cardPadding, 90, "Total time", formatHumanReadable(opts.totalSeconds), theme.accent) +
    renderSummaryMetric(260, 90, "Daily average", formatHumanReadable(opts.dailyAverageSeconds), theme.levels[1]) +
    renderSummaryMetric(cardPadding, 145, "Best day", bestDayText, theme.levels[2]) +
    renderSummaryMetric(260, 145, "Top language", topLanguageText, theme.levels[3]) +
    `</svg>`
  );
}

export function renderLanguagesSvg(opts: LanguagesRenderOptions): string {
  const theme = resolveTheme(opts.theme);
  const width = 495;
  const height = 210;
  const cardPadding = 22;
  const rangeLabel = escapeXml(opts.rangeLabel ?? "the last year");
  const title = `@${escapeXml(truncateText(opts.username, 38))}`;
  const totalText = escapeXml(`${formatHumanReadable(opts.totalSeconds)} total coding time`);
  const ariaLabel = escapeXml(`Top languages card for ${opts.username}`);
  const barX = 148;
  const barWidth = 250;
  const barHeight = 9;

  let rows = "";
  if (opts.languages.length === 0) {
    rows = `<text x="${cardPadding}" y="104" class="subtitle">No language data in ${rangeLabel}</text>`;
  } else {
    for (let i = 0; i < opts.languages.length; i++) {
      const language = opts.languages[i];
      const y = 78 + i * 24;
      const pct = Math.max(0, Math.min(100, language.percent));
      const fill = theme.levels[i % theme.levels.length];
      const filled = Math.max(2, Math.round((barWidth * pct) / 100));
      rows += `<text x="${cardPadding}" y="${y + 9}" class="label">${escapeXml(truncateText(language.language, 16))}</text>`;
      rows += `<rect x="${barX}" y="${y}" width="${barWidth}" height="${barHeight}" rx="4.5" ry="4.5" fill="${theme.cellEmpty}"/>`;
      rows += `<rect x="${barX}" y="${y}" width="${filled}" height="${barHeight}" rx="4.5" ry="4.5" fill="${fill}"/>`;
      rows += `<text x="${width - cardPadding}" y="${y + 9}" text-anchor="end" class="label">${escapeXml(formatPercent(pct))}</text>`;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${ariaLabel}">` +
    cardStyle(theme) +
    `<rect width="100%" height="100%" rx="8" ry="8" fill="${theme.background}" stroke="${theme.border}"/>` +
    `<text x="${cardPadding}" y="31" class="title">${title}</text>` +
    `<text x="${cardPadding}" y="52" class="subtitle">Top languages in ${rangeLabel}</text>` +
    rows +
    `<text x="${cardPadding}" y="${height - 18}" class="note">${totalText}</text>` +
    `<text x="${width - cardPadding}" y="${height - 18}" text-anchor="end" class="note">CloudTime</text>` +
    `</svg>`
  );
}

export function renderStreakSvg(opts: StreakRenderOptions): string {
  const theme = resolveTheme(opts.theme);
  const width = 495;
  const height = 195;
  const cardPadding = 22;
  const metricTop = 78;
  const metricWidth = 142;
  const metricGap = 12;
  const barWidth = 350;
  const barX = cardPadding;
  const barY = 152;
  const streakRatio = opts.longestStreak > 0
    ? Math.min(1, Math.max(0, opts.currentStreak / opts.longestStreak))
    : 0;
  const filledBarWidth = Math.round(barWidth * streakRatio);

  const title = `@${escapeXml(truncateText(opts.username, 38))}`;
  const totalText = escapeXml(`${formatHumanReadable(opts.totalSeconds)} total coding time`);
  const ariaLabel = escapeXml(`Coding streak card for ${opts.username}`);
  const rangeLabel = escapeXml(opts.rangeLabel ?? "the last year");
  const current = escapeXml(formatDays(opts.currentStreak));
  const longest = escapeXml(formatDays(opts.longestStreak));
  const active = escapeXml(formatDays(opts.trackedDays));

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${ariaLabel}">` +
    cardStyle(theme) +
    `<rect width="100%" height="100%" rx="8" ry="8" fill="${theme.background}" stroke="${theme.border}"/>` +
    `<text x="${cardPadding}" y="31" class="title">${title}</text>` +
    `<text x="${cardPadding}" y="52" class="subtitle">Coding streaks in ${rangeLabel}</text>` +
    renderMetric(cardPadding, metricTop, metricWidth, "Current", current, theme.levels[2]) +
    renderMetric(cardPadding + metricWidth + metricGap, metricTop, metricWidth, "Longest", longest, theme.levels[3]) +
    renderMetric(cardPadding + (metricWidth + metricGap) * 2, metricTop, metricWidth, "Active days", active, theme.levels[1]) +
    `<rect x="${barX}" y="${barY}" width="${barWidth}" height="8" rx="4" ry="4" fill="${theme.cellEmpty}"/>` +
    `<rect x="${barX}" y="${barY}" width="${filledBarWidth}" height="8" rx="4" ry="4" fill="${theme.levels[2]}"/>` +
    `<text x="${barX}" y="178" class="note">${totalText}</text>` +
    `<text x="${width - cardPadding}" y="178" text-anchor="end" class="note">CloudTime</text>` +
    `</svg>`
  );
}

function renderMetric(x: number, y: number, width: number, label: string, value: string, accent: string): string {
  return (
    `<g>` +
    `<rect x="${x}" y="${y - 16}" width="${width}" height="3" rx="1.5" ry="1.5" fill="${accent}"/>` +
    `<text x="${x}" y="${y + 18}" class="metric">${value}</text>` +
    `<text x="${x}" y="${y + 40}" class="label">${label}</text>` +
    `</g>`
  );
}

function renderSummaryMetric(x: number, y: number, label: string, value: string, accent: string): string {
  return (
    `<g>` +
    `<rect x="${x}" y="${y - 19}" width="190" height="3" rx="1.5" ry="1.5" fill="${accent}"/>` +
    `<text x="${x}" y="${y}" class="label">${escapeXml(label)}</text>` +
    `<text x="${x}" y="${y + 23}" class="summaryValue">${escapeXml(truncateText(value, 28))}</text>` +
    `</g>`
  );
}

function cardStyle(theme: CardTheme): string {
  return (
    `<style>text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;}` +
    `.title{font-size:16px;font-weight:700;fill:${theme.text};}` +
    `.subtitle{font-size:12px;fill:${theme.subtext};}` +
    `.metric{font-size:25px;font-weight:700;fill:${theme.text};}` +
    `.summaryValue{font-size:18px;font-weight:700;fill:${theme.text};}` +
    `.label{font-size:11px;font-weight:600;fill:${theme.subtext};}` +
    `.note{font-size:11px;fill:${theme.subtext};}</style>`
  );
}

function formatDays(days: number): string {
  const safeDays = Math.max(0, Math.floor(days));
  return `${safeDays} ${safeDays === 1 ? "day" : "days"}`;
}

function formatPercent(percent: number): string {
  const rounded = Math.round(percent);
  return `${rounded}%`;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}
