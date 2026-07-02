import { formatHumanReadable } from "../time-format";
import { escapeXml } from "./render";

export const MAX_TEMPLATE_BYTES = 20_000;
export const TEMPLATE_NAME_MAX = 64;

const ALLOWED_PLACEHOLDERS = new Set([
  "username",
  "card_type",
  "range",
  "theme",
  "total_time",
  "daily_average",
  "best_day",
  "top_language",
  "languages",
  "current_streak",
  "longest_streak",
  "tracked_days",
] as const);

export type CardTemplatePlaceholder = typeof ALLOWED_PLACEHOLDERS extends Set<infer T> ? T : never;
export type CardTemplateValues = Record<CardTemplatePlaceholder, string>;

export type TemplateValidationResult =
  | { ok: true }
  | { ok: false; error: string };

export type TemplateRenderResult =
  | { ok: true; svg: string }
  | { ok: false; error: string };

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const XML_ENTITY_RE = /&(?!amp;|lt;|gt;|quot;|apos;|#[0-9]+;|#x[0-9a-fA-F]+;)/;
const TAG_RE = /<\s*(\/?)\s*([A-Za-z][A-Za-z0-9_.:-]*)([^<>]*?)(\/?)\s*>/g;
const ATTR_RE = /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*("[^"]*"|'[^']*')/g;

const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "rect",
  "circle",
  "ellipse",
  "line",
  "path",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "title",
  "desc",
  "style",
]);

const DISALLOWED_ELEMENTS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "image",
  "use",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "mpath",
  "textpath",
  "feimage",
]);

export function validateTemplateName(name: unknown): TemplateValidationResult {
  if (typeof name !== "string") {
    return { ok: false, error: "name must be a string" };
  }
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > TEMPLATE_NAME_MAX) {
    return { ok: false, error: `name must be 1-${TEMPLATE_NAME_MAX} characters` };
  }
  return { ok: true };
}

export function validateTemplateSvg(svg: unknown): TemplateValidationResult {
  if (typeof svg !== "string") {
    return { ok: false, error: "template_svg must be a string" };
  }
  if (svg.length < 1) {
    return { ok: false, error: "template_svg must not be empty" };
  }
  if (new TextEncoder().encode(svg).length > MAX_TEMPLATE_BYTES) {
    return { ok: false, error: `template_svg must be at most ${MAX_TEMPLATE_BYTES} bytes` };
  }
  if (svg.includes("\u0000")) {
    return { ok: false, error: "template_svg contains invalid control characters" };
  }

  const trimmed = svg.trim();
  if (!trimmed.startsWith("<svg") || !trimmed.endsWith("</svg>")) {
    return { ok: false, error: "template_svg must contain a single <svg> root" };
  }
  if (/<\?/.test(svg)) {
    return { ok: false, error: "processing instructions are not allowed" };
  }
  if (/<\s*!(?:DOCTYPE|ENTITY|\[CDATA)/i.test(svg)) {
    return { ok: false, error: "doctype, entity, and CDATA declarations are not allowed" };
  }
  if (/<\s*script\b/i.test(svg)) {
    return { ok: false, error: "script elements are not allowed" };
  }
  if (/<\s*foreignObject\b/i.test(svg)) {
    return { ok: false, error: "foreignObject elements are not allowed" };
  }
  if (/\son[a-z0-9_.:-]*\s*=/i.test(svg)) {
    return { ok: false, error: "event-handler attributes are not allowed" };
  }
  if (/\b(?:data|javascript|vbscript)\s*:/i.test(svg)) {
    return { ok: false, error: "data and script URL schemes are not allowed" };
  }
  if (/@(?:import|font-face)\b/i.test(svg) || /\burl\s*\(/i.test(svg)) {
    return { ok: false, error: "external CSS resources are not allowed" };
  }
  if (XML_ENTITY_RE.test(svg)) {
    return { ok: false, error: "template_svg contains an unescaped XML entity" };
  }

  const placeholders = validatePlaceholders(svg);
  if (!placeholders.ok) return placeholders;

  return validateTagStructure(svg);
}

export function defaultTemplateValues(overrides: Partial<CardTemplateValues>): CardTemplateValues {
  return {
    username: "",
    card_type: "",
    range: "the last year",
    theme: "default",
    total_time: formatHumanReadable(0),
    daily_average: formatHumanReadable(0),
    best_day: "No activity",
    top_language: "No language",
    languages: "No language data",
    current_streak: formatDays(0),
    longest_streak: formatDays(0),
    tracked_days: formatDays(0),
    ...overrides,
  };
}

export function renderTemplateSvg(templateSvg: string, values: CardTemplateValues): TemplateRenderResult {
  const validation = validateTemplateSvg(templateSvg);
  if (!validation.ok) return validation;

  const svg = templateSvg.replace(PLACEHOLDER_RE, (_match, rawKey: string) => {
    const key = rawKey as CardTemplatePlaceholder;
    return escapeXml(values[key] ?? "");
  });

  return { ok: true, svg };
}

export function formatDays(days: number): string {
  const safeDays = Math.max(0, Math.floor(days));
  return `${safeDays} ${safeDays === 1 ? "day" : "days"}`;
}

export function formatTemplatePercent(percent: number): string {
  return `${Math.round(Math.max(0, Math.min(100, percent)))}%`;
}

function validatePlaceholders(svg: string): TemplateValidationResult {
  for (const match of svg.matchAll(PLACEHOLDER_RE)) {
    const key = match[1];
    if (!ALLOWED_PLACEHOLDERS.has(key as CardTemplatePlaceholder)) {
      return { ok: false, error: `unknown placeholder: ${key}` };
    }
  }

  const stripped = svg.replace(PLACEHOLDER_RE, "");
  if (stripped.includes("{{") || stripped.includes("}}")) {
    return { ok: false, error: "malformed placeholder syntax" };
  }
  return { ok: true };
}

function validateTagStructure(svg: string): TemplateValidationResult {
  const withoutComments = svg.replace(/<!--[\s\S]*?-->/g, "");
  if (withoutComments.includes("<!--") || withoutComments.includes("-->")) {
    return { ok: false, error: "malformed SVG comment" };
  }

  TAG_RE.lastIndex = 0;
  const stack: string[] = [];
  let cursor = 0;
  let rootSeen = false;
  let rootClosed = false;

  for (;;) {
    const match = TAG_RE.exec(withoutComments);
    if (!match) break;

    const before = withoutComments.slice(cursor, match.index);
    if (before.includes("<")) {
      return { ok: false, error: "malformed SVG" };
    }

    const closing = match[1] === "/";
    const tagName = match[2].toLowerCase();
    const attrs = match[3] ?? "";
    const selfClosing = match[4] === "/" || /\/\s*$/.test(attrs);

    if (tagName.includes(":")) {
      return { ok: false, error: "namespaced SVG elements are not allowed" };
    }
    if (DISALLOWED_ELEMENTS.has(tagName) || !ALLOWED_ELEMENTS.has(tagName)) {
      return { ok: false, error: `${tagName} elements are not allowed` };
    }

    if (closing) {
      if (attrs.trim().length > 0) {
        return { ok: false, error: "malformed closing tag" };
      }
      const expected = stack.pop();
      if (expected !== tagName) {
        return { ok: false, error: "malformed SVG tag nesting" };
      }
      if (tagName === "svg") rootClosed = true;
    } else {
      if (!rootSeen) {
        if (tagName !== "svg") {
          return { ok: false, error: "template_svg must contain a single <svg> root" };
        }
        rootSeen = true;
      } else if (rootClosed) {
        return { ok: false, error: "template_svg must contain a single <svg> root" };
      }

      const attrValidation = validateAttributes(attrs);
      if (!attrValidation.ok) return attrValidation;
      if (!selfClosing) stack.push(tagName);
    }

    cursor = match.index + match[0].length;
  }

  const after = withoutComments.slice(cursor);
  if (after.includes("<")) {
    return { ok: false, error: "malformed SVG" };
  }
  if (!rootSeen || stack.length > 0 || !rootClosed) {
    return { ok: false, error: "malformed SVG tag nesting" };
  }

  return { ok: true };
}

function validateAttributes(attrText: string): TemplateValidationResult {
  let attrs = attrText.trim();
  if (attrs.endsWith("/")) attrs = attrs.slice(0, -1).trim();
  if (attrs.length === 0) return { ok: true };

  ATTR_RE.lastIndex = 0;
  let cursor = 0;
  for (;;) {
    const match = ATTR_RE.exec(attrs);
    if (!match) break;

    if (attrs.slice(cursor, match.index).trim().length > 0) {
      return { ok: false, error: "malformed SVG attributes" };
    }

    const name = match[1].toLowerCase();
    const quoted = match[2];
    const value = quoted.slice(1, -1);

    if (name.startsWith("on")) {
      return { ok: false, error: "event-handler attributes are not allowed" };
    }
    if (name === "href" || name === "xlink:href") {
      return { ok: false, error: "href attributes are not allowed in templates" };
    }
    if (name === "xmlns" && value !== "http://www.w3.org/2000/svg") {
      return { ok: false, error: "only the SVG namespace is allowed" };
    }
    if (name === "xmlns:xlink" && value !== "http://www.w3.org/1999/xlink") {
      return { ok: false, error: "only the SVG xlink namespace is allowed" };
    }
    if (!name.startsWith("xmlns") && /\bhttps?\s*:/i.test(value)) {
      return { ok: false, error: "external references are not allowed" };
    }

    cursor = match.index + match[0].length;
  }

  if (attrs.slice(cursor).trim().length > 0) {
    return { ok: false, error: "malformed SVG attributes" };
  }
  return { ok: true };
}
