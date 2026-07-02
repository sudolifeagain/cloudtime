import { describe, expect, it } from "vitest";
import {
  MAX_TEMPLATE_BYTES,
  defaultTemplateValues,
  renderTemplateSvg,
  validateTemplateSvg,
} from "../../src/utils/cards/templates";

const VALID_TEMPLATE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80" viewBox="0 0 320 80" role="img">' +
  '<rect width="320" height="80" fill="#fff"></rect>' +
  '<text x="12" y="28" font-family="Arial, sans-serif">{{username}}</text>' +
  '<text x="12" y="54" font-family="Arial, sans-serif">{{total_time}}</text>' +
  "</svg>";

describe("validateTemplateSvg", () => {
  it("accepts a static SVG template with known placeholders", () => {
    expect(validateTemplateSvg(VALID_TEMPLATE)).toEqual({ ok: true });
  });

  it.each([
    ["script element", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ["event handler", '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="evil()" /></svg>'],
    ["foreignObject", '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>html</div></foreignObject></svg>'],
    ["style element", '<svg xmlns="http://www.w3.org/2000/svg"><style>text{fill:red}</style></svg>'],
    ["style attribute", '<svg xmlns="http://www.w3.org/2000/svg"><text style="fill:red">x</text></svg>'],
    ["external href", '<svg xmlns="http://www.w3.org/2000/svg"><text href="https://example.test">x</text></svg>'],
    [
      "xlink href",
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><text xlink:href="#x">x</text></svg>',
    ],
    [
      "remote font",
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@font-face{font-family:X;src:url(https://example.test/x.woff2)}</style></svg>',
    ],
    [
      "entity-obfuscated CSS URL",
      '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{filter:u&#x72;l(https://example.test/x)}</style><rect /></svg>',
    ],
    [
      "CSS escape URL",
      '<svg xmlns="http://www.w3.org/2000/svg"><rect filter="u\\72l(https://example.test/x)" /></svg>',
    ],
    ["data URL", '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="data:image/png;base64,aaaa" /></svg>'],
    ["processing instruction", '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ["malformed SVG", '<svg xmlns="http://www.w3.org/2000/svg"><text>oops</svg>'],
    ["unknown placeholder", '<svg xmlns="http://www.w3.org/2000/svg"><text>{{token}}</text></svg>'],
  ])("rejects %s", (_name, template) => {
    const result = validateTemplateSvg(template);
    expect(result.ok).toBe(false);
  });

  it("rejects oversized templates by byte length", () => {
    const result = validateTemplateSvg(
      `<svg xmlns="http://www.w3.org/2000/svg"><text>${"a".repeat(MAX_TEMPLATE_BYTES)}</text></svg>`,
    );
    expect(result.ok).toBe(false);
  });
});

describe("renderTemplateSvg", () => {
  it("substitutes placeholders with XML escaping", () => {
    const result = renderTemplateSvg(VALID_TEMPLATE, defaultTemplateValues({
      username: '<script>alert("x")</script>&',
      total_time: "1 hr",
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.svg).not.toContain("<script>");
    expect(result.svg).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;");
    expect(result.svg).toContain("1 hr");
  });
});
