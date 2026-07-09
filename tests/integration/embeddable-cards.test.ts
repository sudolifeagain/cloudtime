import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { seedUser, truncate } from "../helpers/fixtures";

const BASE = "https://test.cloudtime.dev";

afterEach(async () => {
  await truncate("heartbeats", "summaries", "goals", "embed_templates", "embed_settings", "users");
});

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function authPatch(apiKey: string, body: unknown): RequestInit {
  return {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

function authJson(apiKey: string, method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function formatUtcDate(daysFromToday: number): string {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  today.setUTCDate(today.getUTCDate() + daysFromToday);
  return today.toISOString().slice(0, 10);
}

async function seedSummary(userId: string, date: string, totalSeconds: number, language?: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO summaries (user_id, date, project, language, total_seconds) VALUES (?, ?, 'cards', ?, ?)",
  )
    .bind(userId, date, language ?? null, totalSeconds)
    .run();
}

async function seedGoal(
  userId: string,
  overrides: Partial<{
    title: string;
    type: string;
    delta: string;
    targetSeconds: number;
    enabled: boolean;
    snoozed: boolean;
    inverse: boolean;
    createdAt: string;
  }> = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO goals (id, user_id, title, type, delta, target_seconds, is_enabled, is_snoozed, is_inverse, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  )
    .bind(
      id,
      userId,
      overrides.title ?? "Code 2 hrs",
      overrides.type ?? "coding",
      overrides.delta ?? "day",
      overrides.targetSeconds ?? 7200,
      overrides.enabled === false ? 0 : 1,
      overrides.snoozed ? 1 : 0,
      overrides.inverse ? 1 : 0,
      overrides.createdAt ?? "2026-01-01 00:00:00",
    )
    .run();
  return id;
}

async function enableEmbeds(apiKey: string): Promise<void> {
  const res = await call(`/api/v1/users/current/embed_settings`, authPatch(apiKey, { enabled: true }));
  expect(res.status).toBe(200);
}

describe("embeddable cards — public visibility", () => {
  it("returns 404 when embeds are OFF by default", async () => {
    const user = await seedUser({ username: "alice" });
    const res = await call(`/api/v1/users/${user.username}/cards/heatmap.svg`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown user", async () => {
    const res = await call(`/api/v1/users/ghost/cards/heatmap.svg`);
    expect(res.status).toBe(404);
  });

  it("renders the heatmap as SVG once embeds are enabled", async () => {
    const user = await seedUser({ username: "owner" });
    const patch = await call(`/api/v1/users/current/embed_settings`, authPatch(user.apiKey, { enabled: true }));
    expect(patch.status).toBe(200);
    const patchBody = (await patch.json()) as { data: { enabled: boolean } };
    expect(patchBody.data.enabled).toBe(true);

    const res = await call(`/api/v1/users/${user.username}/cards/heatmap.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(res.headers.get("Cache-Control")).toContain("max-age=");
    expect(res.headers.get("ETag")).toBeTruthy();

    const svg = await res.text();
    expect(svg.startsWith("<svg")).toBe(true);
    // The card URL is unauthenticated and must never echo a secret.
    expect(svg).not.toContain(user.apiKey);
  });

  it("renders the streak card as SVG once embeds are enabled", async () => {
    const user = await seedUser({ username: "streak_owner" });
    await call(`/api/v1/users/current/embed_settings`, authPatch(user.apiKey, { enabled: true }));

    await env.DB.prepare(
      "INSERT INTO summaries (user_id, date, project, total_seconds) VALUES (?, ?, 'cards', ?)",
    )
      .bind(user.userId, formatUtcDate(-2), 1800)
      .run();
    await env.DB.prepare(
      "INSERT INTO summaries (user_id, date, project, total_seconds) VALUES (?, ?, 'cards', ?)",
    )
      .bind(user.userId, formatUtcDate(-1), 3600)
      .run();

    const res = await call(`/api/v1/users/${user.username}/cards/streak.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(res.headers.get("Cache-Control")).toContain("max-age=");
    expect(res.headers.get("ETag")).toBeTruthy();

    const svg = await res.text();
    expect(svg).toContain("CloudTime coding activity streaks in the last year");
    expect(svg).toContain("2 days");
    expect(svg).toContain("1 hr 30 mins total coding time");
    expect(svg).not.toContain(user.apiKey);
  });

  it("applies the requested streak range to rendered totals", async () => {
    const user = await seedUser({ username: "streak_range" });
    await call(`/api/v1/users/current/embed_settings`, authPatch(user.apiKey, { enabled: true }));

    await env.DB.prepare(
      "INSERT INTO summaries (user_id, date, project, total_seconds) VALUES (?, ?, 'cards', ?)",
    )
      .bind(user.userId, formatUtcDate(-7), 7200)
      .run();
    await env.DB.prepare(
      "INSERT INTO summaries (user_id, date, project, total_seconds) VALUES (?, ?, 'cards', ?)",
    )
      .bind(user.userId, formatUtcDate(-6), 3600)
      .run();

    const res = await call(`/api/v1/users/${user.username}/cards/streak.svg?range=last_7_days`);
    expect(res.status).toBe(200);

    const svg = await res.text();
    expect(svg).toContain("CloudTime coding activity streaks in the last 7 days");
    expect(svg).toContain("1 hr total coding time");
    expect(svg).not.toContain("3 hrs total coding time");

    const fallback = await call(`/api/v1/users/${user.username}/cards/streak.svg?range=not_supported`);
    expect(fallback.status).toBe(200);
    const fallbackSvg = await fallback.text();
    expect(fallbackSvg).toContain("CloudTime coding activity streaks in the last year");
    expect(fallbackSvg).toContain("3 hrs total coding time");
  });

  it("honors weak and listed If-None-Match validators", async () => {
    const user = await seedUser({ username: "etag_user" });
    await call(`/api/v1/users/current/embed_settings`, authPatch(user.apiKey, { enabled: true }));

    const first = await call(`/api/v1/users/${user.username}/cards/heatmap.svg`);
    expect(first.status).toBe(200);
    const etag = first.headers.get("ETag");
    expect(etag).toBeTruthy();

    const revalidated = await call(`/api/v1/users/${user.username}/cards/heatmap.svg`, {
      headers: { "If-None-Match": `"miss", W/${etag}` },
    });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
  });

  it("rejects an overlong cache-busting value before building a KV key", async () => {
    const user = await seedUser({ username: "cache_key" });
    await call(`/api/v1/users/current/embed_settings`, authPatch(user.apiKey, { enabled: true }));

    const res = await call(`/api/v1/users/${user.username}/cards/heatmap.svg?v=${"x".repeat(65)}`);
    expect(res.status).toBe(400);
  });

  it("returns 404 even with a warm cache after embeds are turned OFF", async () => {
    const user = await seedUser({ username: "bob" });
    await call(`/api/v1/users/current/embed_settings`, authPatch(user.apiKey, { enabled: true }));

    const warm = await call(`/api/v1/users/${user.username}/cards/heatmap.svg`);
    expect(warm.status).toBe(200);

    await call(`/api/v1/users/current/embed_settings`, authPatch(user.apiKey, { enabled: false }));

    const res = await call(`/api/v1/users/${user.username}/cards/heatmap.svg`);
    expect(res.status).toBe(404);
  });

  it("renders summary and languages cards for requested ranges", async () => {
    const user = await seedUser({ username: "carol" });
    await call(`/api/v1/users/current/embed_settings`, authPatch(user.apiKey, { enabled: true }));

    const bestDay = formatUtcDate(-2);
    await env.DB.prepare(
      "INSERT INTO summaries (user_id, date, project, language, total_seconds) VALUES (?, ?, 'cards', 'TypeScript', ?)",
    )
      .bind(user.userId, bestDay, 7200)
      .run();
    await env.DB.prepare(
      "INSERT INTO summaries (user_id, date, project, language, total_seconds) VALUES (?, ?, 'cards', 'Markdown', ?)",
    )
      .bind(user.userId, formatUtcDate(-1), 3600)
      .run();
    await env.DB.prepare(
      "INSERT INTO summaries (user_id, date, project, language, total_seconds) VALUES (?, ?, 'cards', '', ?)",
    )
      .bind(user.userId, formatUtcDate(-1), 10800)
      .run();
    await env.DB.prepare(
      "INSERT INTO summaries (user_id, date, project, language, total_seconds) VALUES (?, ?, 'cards', 'Go', ?)",
    )
      .bind(user.userId, formatUtcDate(-8), 1800)
      .run();

    const summary = await call(`/api/v1/users/${user.username}/cards/summary.svg?range=last_7_days`);
    expect(summary.status).toBe(200);
    expect(summary.headers.get("Content-Type")).toContain("image/svg+xml");
    const summarySvg = await summary.text();
    expect(summarySvg).toContain("Coding summary in the last 7 days");
    expect(summarySvg).toContain("6 hrs");
    expect(summarySvg).toContain(`${formatUtcDate(-1)} / 4 hrs`);
    expect(summarySvg).toContain("TypeScript / 67%");
    expect(summarySvg).not.toContain("Unknown");
    expect(summarySvg).not.toContain(user.apiKey);

    const languages = await call(`/api/v1/users/${user.username}/cards/languages.svg?range=last_7_days`);
    expect(languages.status).toBe(200);
    const languagesSvg = await languages.text();
    expect(languagesSvg).toContain("Top languages in the last 7 days");
    expect(languagesSvg).toContain("TypeScript");
    expect(languagesSvg).toContain("67%");
    expect(languagesSvg).toContain("Markdown");
    expect(languagesSvg).toContain("33%");
    expect(languagesSvg).not.toContain("Unknown");
    expect(languagesSvg).not.toContain("Go");

    const fallback = await call(`/api/v1/users/${user.username}/cards/languages.svg?range=not_supported`);
    expect(fallback.status).toBe(200);
    const fallbackSvg = await fallback.text();
    expect(fallbackSvg).toContain("Top languages in the last year");
    expect(fallbackSvg).toContain("Go");
    expect(fallbackSvg).toContain("3 hrs 30 mins total coding time");
    expect(fallbackSvg).not.toContain("Unknown");
  });

  it("applies built-in themes and falls back to default for unknown themes", async () => {
    const user = await seedUser({ username: "theme_user" });
    await call(`/api/v1/users/current/embed_settings`, authPatch(user.apiKey, { enabled: true }));

    const dark = await call(`/api/v1/users/${user.username}/cards/heatmap.svg?theme=dark`);
    expect(dark.status).toBe(200);
    expect(await dark.text()).toContain("#0d1117");

    const fallback = await call(`/api/v1/users/${user.username}/cards/summary.svg?theme=future_theme`);
    expect(fallback.status).toBe(200);
    const fallbackSvg = await fallback.text();
    expect(fallbackSvg).toContain("#ffffff");
    expect(fallbackSvg).not.toContain("#0d1117");
  });

  it("reflects today's activity computed on demand from raw heartbeats", async () => {
    const user = await seedUser({ username: "dave" });
    await call(`/api/v1/users/current/embed_settings`, authPatch(user.apiKey, { enabled: true }));

    // Three heartbeats spaced 60s apart (gaps under the 15-min timeout) → 120s.
    const now = Math.floor(Date.now() / 1000);
    for (const t of [now - 120, now - 60, now]) {
      await env.DB.prepare(
        "INSERT INTO heartbeats (id, user_id, entity, time) VALUES (?, ?, ?, ?)",
      )
        .bind(crypto.randomUUID(), user.userId, "file.ts", t)
        .run();
    }

    const res = await call(`/api/v1/users/${user.username}/cards/heatmap.svg`);
    expect(res.status).toBe(200);
    const svg = await res.text();
    expect(svg).toContain("2 mins in the last year");
  });

  it("renders a public card through an owned custom template", async () => {
    const user = await seedUser({ username: "templated" });
    await call(`/api/v1/users/current/embed_settings`, authPatch(user.apiKey, { enabled: true }));

    const bestDay = formatUtcDate(-1);
    await env.DB.prepare(
      "INSERT INTO summaries (user_id, date, project, language, total_seconds) VALUES (?, ?, 'cards', 'TypeScript', ?)",
    )
      .bind(user.userId, bestDay, 7200)
      .run();

    const created = await call(
      "/api/v1/users/current/embed_templates",
      authJson(user.apiKey, "POST", {
        name: "summary badge",
        template_svg:
          '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="96" viewBox="0 0 360 96" role="img">' +
          '<text x="12" y="28">{{username}}</text>' +
          '<text x="12" y="54">{{total_time}}</text>' +
          '<text x="12" y="80">{{top_language}}</text>' +
          "</svg>",
      }),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { data: { id: string } };

    const res = await call(`/api/v1/users/${user.username}/cards/summary.svg?range=last_7_days&template_id=${body.data.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");

    const svg = await res.text();
    expect(svg).toContain("templated");
    expect(svg).toContain("2 hrs");
    expect(svg).toContain("TypeScript / 100%");
    expect(svg).not.toContain(user.apiKey);
  });

  it("returns 404 when a public card references another user's template", async () => {
    const owner = await seedUser({ username: "template_owner" });
    const viewer = await seedUser({ username: "template_viewer" });
    await call(`/api/v1/users/current/embed_settings`, authPatch(viewer.apiKey, { enabled: true }));

    const created = await call(
      "/api/v1/users/current/embed_templates",
      authJson(owner.apiKey, "POST", {
        name: "private template",
        template_svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>{{username}}</text></svg>',
      }),
    );
    const body = (await created.json()) as { data: { id: string } };

    const res = await call(`/api/v1/users/${viewer.username}/cards/summary.svg?template_id=${body.data.id}`);
    expect(res.status).toBe(404);
  });

  it("revalidates stored templates before public rendering", async () => {
    const user = await seedUser({ username: "revalidate" });
    await call(`/api/v1/users/current/embed_settings`, authPatch(user.apiKey, { enabled: true }));
    const templateId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO embed_templates (id, user_id, name, template_svg, created_at, modified_at)
       VALUES (?, ?, 'unsafe', ?, datetime('now'), datetime('now'))`,
    )
      .bind(templateId, user.userId, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
      .run();

    const res = await call(`/api/v1/users/${user.username}/cards/summary.svg?template_id=${templateId}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("script");
  });
});

describe("embeddable cards — settings auth", () => {
  it("requires authentication to read embed settings", async () => {
    const res = await call(`/api/v1/users/current/embed_settings`);
    expect(res.status).toBe(401);
  });

  it("rejects an out-of-range freshness_minutes", async () => {
    const user = await seedUser({ username: "erin" });
    const res = await call(`/api/v1/users/current/embed_settings`, authPatch(user.apiKey, { freshness_minutes: 0 }));
    expect(res.status).toBe(400);
  });

  it("rejects an empty settings patch", async () => {
    const user = await seedUser({ username: "grace" });
    const res = await call(`/api/v1/users/current/embed_settings`, authPatch(user.apiKey, {}));
    expect(res.status).toBe(400);
  });

  it("rejects default_theme values outside the OpenAPI pattern", async () => {
    const user = await seedUser({ username: "heidi" });
    const res = await call(`/api/v1/users/current/embed_settings`, authPatch(user.apiKey, { default_theme: "Dark Mode" }));
    expect(res.status).toBe(400);
  });

  it("normalizes an unknown but syntactically valid default theme to default", async () => {
    const user = await seedUser({ username: "ivan" });
    const res = await call(`/api/v1/users/current/embed_settings`, authPatch(user.apiKey, { default_theme: "future_theme" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { default_theme: string } };
    expect(body.data.default_theme).toBe("default");
  });

  it("defaults to OFF with a 15-minute freshness window", async () => {
    const user = await seedUser({ username: "frank" });
    const res = await call(`/api/v1/users/current/embed_settings`, {
      headers: { Authorization: `Bearer ${user.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { enabled: boolean; freshness_minutes: number; default_theme: string } };
    expect(body.data.enabled).toBe(false);
    expect(body.data.freshness_minutes).toBe(15);
    expect(body.data.default_theme).toBe("default");
  });
});

describe("embeddable cards - template auth", () => {
  it("requires authentication to list embed templates", async () => {
    const res = await call("/api/v1/users/current/embed_templates");
    expect(res.status).toBe(401);
  });

  it("supports template CRUD for the authenticated user", async () => {
    const user = await seedUser({ username: "template_crud" });
    const templateSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>{{username}}</text></svg>';

    const created = await call(
      "/api/v1/users/current/embed_templates",
      authJson(user.apiKey, "POST", { name: "Profile card", template_svg: templateSvg }),
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { data: { id: string; name: string; template_svg: string } };
    expect(createdBody.data.name).toBe("Profile card");
    expect(createdBody.data.template_svg).toBe(templateSvg);

    const listed = await call("/api/v1/users/current/embed_templates", {
      headers: { Authorization: `Bearer ${user.apiKey}` },
    });
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as { data: Array<{ id: string }> };
    expect(listBody.data.map((item) => item.id)).toContain(createdBody.data.id);

    const fetched = await call(`/api/v1/users/current/embed_templates/${createdBody.data.id}`, {
      headers: { Authorization: `Bearer ${user.apiKey}` },
    });
    expect(fetched.status).toBe(200);

    const patched = await call(
      `/api/v1/users/current/embed_templates/${createdBody.data.id}`,
      authJson(user.apiKey, "PATCH", { name: "Updated card" }),
    );
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as { data: { name: string } };
    expect(patchedBody.data.name).toBe("Updated card");

    const deleted = await call(
      `/api/v1/users/current/embed_templates/${createdBody.data.id}`,
      authJson(user.apiKey, "DELETE"),
    );
    expect(deleted.status).toBe(204);

    const missing = await call(`/api/v1/users/current/embed_templates/${createdBody.data.id}`, {
      headers: { Authorization: `Bearer ${user.apiKey}` },
    });
    expect(missing.status).toBe(404);
  });

  it("returns 404 for cross-user template access", async () => {
    const owner = await seedUser({ username: "template_owner_auth" });
    const other = await seedUser({ username: "template_other_auth" });

    const created = await call(
      "/api/v1/users/current/embed_templates",
      authJson(owner.apiKey, "POST", {
        name: "Owner template",
        template_svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>{{username}}</text></svg>',
      }),
    );
    const body = (await created.json()) as { data: { id: string } };

    const res = await call(`/api/v1/users/current/embed_templates/${body.data.id}`, {
      headers: { Authorization: `Bearer ${other.apiKey}` },
    });
    expect(res.status).toBe(404);
  });

  it("rejects unsafe template creation and stores nothing", async () => {
    const user = await seedUser({ username: "template_invalid" });

    const res = await call(
      "/api/v1/users/current/embed_templates",
      authJson(user.apiKey, "POST", {
        name: "bad",
        template_svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      }),
    );
    expect(res.status).toBe(400);

    const listed = await call("/api/v1/users/current/embed_templates", {
      headers: { Authorization: `Bearer ${user.apiKey}` },
    });
    const listBody = (await listed.json()) as { data: unknown[] };
    expect(listBody.data).toHaveLength(0);
  });

  it("rejects empty template patches", async () => {
    const user = await seedUser({ username: "template_empty_patch" });
    const created = await call(
      "/api/v1/users/current/embed_templates",
      authJson(user.apiKey, "POST", {
        name: "patch target",
        template_svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>{{username}}</text></svg>',
      }),
    );
    const body = (await created.json()) as { data: { id: string } };

    const res = await call(
      `/api/v1/users/current/embed_templates/${body.data.id}`,
      authJson(user.apiKey, "PATCH", {}),
    );
    expect(res.status).toBe(400);
  });
});

describe("public badges - routes", () => {
  it("returns 404 when embeds are OFF by default", async () => {
    const user = await seedUser({ username: "badge_off" });
    const res = await call(`/api/v1/users/${user.username}/badges/coding_time.svg`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown user and unknown badge types", async () => {
    expect((await call(`/api/v1/users/ghost/badges/coding_time.svg`)).status).toBe(404);

    const user = await seedUser({ username: "badge_unknown_type" });
    await enableEmbeds(user.apiKey);
    expect((await call(`/api/v1/users/${user.username}/badges/velocity.svg`)).status).toBe(404);
    expect((await call(`/api/v1/users/${user.username}/badges/coding_time.png`)).status).toBe(404);
  });

  it("renders the coding_time badge for today from raw heartbeats", async () => {
    const user = await seedUser({ username: "badge_today" });
    await enableEmbeds(user.apiKey);

    const now = Math.floor(Date.now() / 1000);
    for (const t of [now - 120, now - 60, now]) {
      await env.DB.prepare(
        "INSERT INTO heartbeats (id, user_id, entity, time) VALUES (?, ?, ?, ?)",
      )
        .bind(crypto.randomUUID(), user.userId, "file.ts", t)
        .run();
    }

    const res = await call(`/api/v1/users/${user.username}/badges/coding_time.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(res.headers.get("Cache-Control")).toContain("max-age=");
    expect(res.headers.get("ETag")).toBeTruthy();

    const svg = await res.text();
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('role="img"');
    expect(svg).toContain("aria-label=");
    expect(svg).toContain(">today</text>");
    expect(svg).toContain(">2 mins</text>");
    expect(svg).not.toContain(user.apiKey);
  });

  it("applies range windows and all_time to the coding_time badge", async () => {
    const user = await seedUser({ username: "badge_ranges" });
    await enableEmbeds(user.apiKey);
    await seedSummary(user.userId, formatUtcDate(-1), 3600);
    await seedSummary(user.userId, "2020-01-01", 7200);

    const week = await call(`/api/v1/users/${user.username}/badges/coding_time.svg?range=last_7_days`);
    expect(week.status).toBe(200);
    const weekSvg = await week.text();
    expect(weekSvg).toContain(">last 7 days</text>");
    expect(weekSvg).toContain(">1 hr</text>");

    const allTime = await call(`/api/v1/users/${user.username}/badges/coding_time.svg?range=all_time`);
    expect(allTime.status).toBe(200);
    const allTimeSvg = await allTime.text();
    expect(allTimeSvg).toContain(">all time</text>");
    expect(allTimeSvg).toContain(">3 hrs</text>");
  });

  it("renders the top_language badge over its default trailing week", async () => {
    const user = await seedUser({ username: "badge_language" });
    await enableEmbeds(user.apiKey);
    await seedSummary(user.userId, formatUtcDate(-1), 7200, "TypeScript");
    await seedSummary(user.userId, formatUtcDate(-2), 3600, "Markdown");
    await seedSummary(user.userId, formatUtcDate(-30), 36000, "Go");

    const res = await call(`/api/v1/users/${user.username}/badges/top_language.svg`);
    expect(res.status).toBe(200);
    const svg = await res.text();
    expect(svg).toContain(">top language</text>");
    expect(svg).toContain(">TypeScript</text>");
    expect(svg).not.toContain("Go");
  });

  it("renders the current_streak badge and ignores a valid range parameter", async () => {
    const user = await seedUser({ username: "badge_streak" });
    await enableEmbeds(user.apiKey);
    await seedSummary(user.userId, formatUtcDate(-1), 3600);
    await seedSummary(user.userId, formatUtcDate(-2), 3600);

    const res = await call(`/api/v1/users/${user.username}/badges/current_streak.svg?range=all_time`);
    expect(res.status).toBe(200);
    const svg = await res.text();
    expect(svg).toContain(">streak</text>");
    expect(svg).toContain(">2 days</text>");
  });

  it("supports label overrides, pill style, and built-in themes", async () => {
    const user = await seedUser({ username: "badge_options" });
    await enableEmbeds(user.apiKey);

    const res = await call(
      `/api/v1/users/${user.username}/badges/coding_time.svg?label=Focus&style=pill&theme=dark`,
    );
    expect(res.status).toBe(200);
    const svg = await res.text();
    expect(svg).toContain(">Focus</text>");
    expect(svg).toContain('rx="12"');
    expect(svg).toContain("#0d1117");
  });

  it("rejects invalid badge query parameters with 400", async () => {
    const user = await seedUser({ username: "badge_invalid" });
    await enableEmbeds(user.apiKey);
    const base = `/api/v1/users/${user.username}/badges/coding_time.svg`;

    expect((await call(`${base}?range=yesterday`)).status).toBe(400);
    expect((await call(`${base}?style=round`)).status).toBe(400);
    expect((await call(`${base}?label=`)).status).toBe(400);
    expect((await call(`${base}?label=${"x".repeat(25)}`)).status).toBe(400);
    expect((await call(`${base}?goal_id=not-a-uuid`)).status).toBe(400);
    expect((await call(`${base}?v=${"x".repeat(65)}`)).status).toBe(400);
  });
});

describe("public badges - goal progress", () => {
  it("returns 404 when the user has no eligible goal", async () => {
    const user = await seedUser({ username: "goal_none" });
    await enableEmbeds(user.apiKey);
    const res = await call(`/api/v1/users/${user.username}/badges/goal_progress.svg`);
    expect(res.status).toBe(404);
  });

  it("uses the first enabled, non-snoozed goal ordered by creation time", async () => {
    const user = await seedUser({ username: "goal_default" });
    await enableEmbeds(user.apiKey);
    await seedGoal(user.userId, { targetSeconds: 3600, enabled: false, createdAt: "2026-01-01 00:00:00" });
    await seedGoal(user.userId, { targetSeconds: 3600, snoozed: true, createdAt: "2026-01-02 00:00:00" });
    await seedGoal(user.userId, { targetSeconds: 7200, createdAt: "2026-01-03 00:00:00" });
    await seedGoal(user.userId, { targetSeconds: 60, createdAt: "2026-01-04 00:00:00" });
    await seedSummary(user.userId, formatUtcDate(0), 3600);

    const res = await call(`/api/v1/users/${user.username}/badges/goal_progress.svg`);
    expect(res.status).toBe(200);
    const svg = await res.text();
    // 3600 of the 7200-second goal, not the disabled/snoozed/newer ones.
    expect(svg).toContain(">50%</text>");
  });

  it("selects a specific eligible goal by goal_id", async () => {
    const user = await seedUser({ username: "goal_by_id" });
    await enableEmbeds(user.apiKey);
    await seedGoal(user.userId, { targetSeconds: 7200, createdAt: "2026-01-01 00:00:00" });
    const goalId = await seedGoal(user.userId, { targetSeconds: 14400, createdAt: "2026-01-02 00:00:00" });
    await seedSummary(user.userId, formatUtcDate(0), 3600);

    const res = await call(`/api/v1/users/${user.username}/badges/goal_progress.svg?goal_id=${goalId}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(">25%</text>");
  });

  it("returns 404 for missing, disabled, or cross-user goal ids", async () => {
    const owner = await seedUser({ username: "goal_owner" });
    const viewer = await seedUser({ username: "goal_viewer" });
    await enableEmbeds(viewer.apiKey);
    const foreignGoal = await seedGoal(owner.userId);
    const disabledGoal = await seedGoal(viewer.userId, { enabled: false });

    const missing = await call(
      `/api/v1/users/${viewer.username}/badges/goal_progress.svg?goal_id=${crypto.randomUUID()}`,
    );
    expect(missing.status).toBe(404);

    const foreign = await call(
      `/api/v1/users/${viewer.username}/badges/goal_progress.svg?goal_id=${foreignGoal}`,
    );
    expect(foreign.status).toBe(404);

    const disabled = await call(
      `/api/v1/users/${viewer.username}/badges/goal_progress.svg?goal_id=${disabledGoal}`,
    );
    expect(disabled.status).toBe(404);
  });

  it("renders an inverse goal under its cap as percent of cap", async () => {
    const user = await seedUser({ username: "goal_inverse_under" });
    await enableEmbeds(user.apiKey);
    await seedGoal(user.userId, { targetSeconds: 7200, inverse: true });
    await seedSummary(user.userId, formatUtcDate(0), 3600);

    const res = await call(`/api/v1/users/${user.username}/badges/goal_progress.svg`);
    expect(res.status).toBe(200);
    const svg = await res.text();
    expect(svg).toContain(">50% of cap</text>");
  });

  it("renders an exceeded inverse cap without overachievement framing", async () => {
    const user = await seedUser({ username: "goal_inverse_over" });
    await enableEmbeds(user.apiKey);
    await seedGoal(user.userId, { targetSeconds: 3600, inverse: true });
    await seedSummary(user.userId, formatUtcDate(0), 10800);

    const res = await call(`/api/v1/users/${user.username}/badges/goal_progress.svg`);
    expect(res.status).toBe(200);
    const svg = await res.text();
    // 3 hrs against a 1-hr cap: honest "300% of cap", not a bare achievement %.
    expect(svg).toContain(">300% of cap</text>");
  });

  it("returns 404 for a goal_progress badge with a warm cache after the goal is disabled", async () => {
    const user = await seedUser({ username: "goal_warm_disable" });
    await enableEmbeds(user.apiKey);
    const goalId = await seedGoal(user.userId, { targetSeconds: 7200 });
    await seedSummary(user.userId, formatUtcDate(0), 3600);

    const warm = await call(`/api/v1/users/${user.username}/badges/goal_progress.svg`);
    expect(warm.status).toBe(200);
    expect(await warm.text()).toContain(">50%</text>");

    await env.DB.prepare("UPDATE goals SET is_enabled = 0 WHERE id = ?").bind(goalId).run();

    const res = await call(`/api/v1/users/${user.username}/badges/goal_progress.svg`);
    expect(res.status).toBe(404);
  });

  it("re-renders a goal_progress badge after the goal target changes", async () => {
    const user = await seedUser({ username: "goal_edit" });
    await enableEmbeds(user.apiKey);
    const goalId = await seedGoal(user.userId, { targetSeconds: 7200 });
    await seedSummary(user.userId, formatUtcDate(0), 3600);

    const warm = await call(`/api/v1/users/${user.username}/badges/goal_progress.svg`);
    expect(await warm.text()).toContain(">50%</text>");

    // Editing the goal bumps modified_at, which the cache key folds in so the
    // warm entry cannot mask the new target.
    await env.DB.prepare("UPDATE goals SET target_seconds = 3600, modified_at = ? WHERE id = ?")
      .bind("2026-02-02 00:00:00", goalId)
      .run();

    const res = await call(`/api/v1/users/${user.username}/badges/goal_progress.svg`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(">100%</text>");
  });
});

describe("public profile card", () => {
  it("renders the default metric set with an accessible name", async () => {
    const user = await seedUser({ username: "profile_default" });
    await enableEmbeds(user.apiKey);
    await seedSummary(user.userId, formatUtcDate(-1), 3600, "TypeScript");

    const res = await call(`/api/v1/users/${user.username}/cards/profile.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/svg+xml");
    expect(res.headers.get("Cache-Control")).toContain("max-age=");
    expect(res.headers.get("ETag")).toBeTruthy();

    const svg = await res.text();
    expect(svg).toContain('role="img"');
    expect(svg).toContain(`CloudTime profile card for ${user.username}`);
    expect(svg).toContain("Today");
    expect(svg).toContain("Last 7 days");
    expect(svg).toContain("Top language");
    expect(svg).toContain("Current streak");
    expect(svg).toContain("TypeScript / 100%");
    expect(svg).not.toContain(user.apiKey);
  });

  it("renders requested metrics in the requested order", async () => {
    const user = await seedUser({ username: "profile_ordered" });
    await enableEmbeds(user.apiKey);
    await seedSummary(user.userId, "2020-01-01", 7200);

    const res = await call(
      `/api/v1/users/${user.username}/cards/profile.svg?metrics=all_time,today`,
    );
    expect(res.status).toBe(200);
    const svg = await res.text();
    expect(svg).toContain("All time");
    expect(svg).toContain("2 hrs");
    expect(svg.indexOf("All time")).toBeLessThan(svg.indexOf("Today"));
    expect(svg).not.toContain("Top language");
  });

  it("rejects unknown, duplicate, and empty metrics entries", async () => {
    const user = await seedUser({ username: "profile_metrics_invalid" });
    await enableEmbeds(user.apiKey);
    const base = `/api/v1/users/${user.username}/cards/profile.svg`;

    expect((await call(`${base}?metrics=velocity`)).status).toBe(400);
    expect((await call(`${base}?metrics=today,today`)).status).toBe(400);
    expect((await call(`${base}?metrics=today,,week`)).status).toBe(400);
    expect((await call(`${base}?metrics=`)).status).toBe(400);
    expect((await call(`${base}?layout=wide`)).status).toBe(400);
  });

  it("ignores metrics and layout on non-profile card types", async () => {
    const user = await seedUser({ username: "profile_param_scope" });
    await enableEmbeds(user.apiKey);
    const res = await call(
      `/api/v1/users/${user.username}/cards/heatmap.svg?metrics=velocity&layout=wide`,
    );
    expect(res.status).toBe(200);
  });

  it("renders the compact layout", async () => {
    const user = await seedUser({ username: "profile_compact" });
    await enableEmbeds(user.apiKey);

    const res = await call(`/api/v1/users/${user.username}/cards/profile.svg?layout=compact`);
    expect(res.status).toBe(200);
    const svg = await res.text();
    expect(svg).toContain('width="320"');
    expect(svg).toContain("Current streak");
  });

  it("renders goal progress when an eligible goal exists and 404s otherwise", async () => {
    const user = await seedUser({ username: "profile_goal" });
    await enableEmbeds(user.apiKey);

    const missing = await call(`/api/v1/users/${user.username}/cards/profile.svg?metrics=goal_progress`);
    expect(missing.status).toBe(404);

    await seedGoal(user.userId, { targetSeconds: 7200, delta: "day" });
    await seedSummary(user.userId, formatUtcDate(0), 3600);
    const res = await call(`/api/v1/users/${user.username}/cards/profile.svg?metrics=goal_progress`);
    expect(res.status).toBe(200);
    const svg = await res.text();
    expect(svg).toContain("Goal progress");
    expect(svg).toContain("50% of 2 hrs / day");
  });

  it("renders the profile card through an owned custom template", async () => {
    const user = await seedUser({ username: "profile_templated" });
    await enableEmbeds(user.apiKey);
    await seedSummary(user.userId, formatUtcDate(-1), 3600);

    const created = await call(
      "/api/v1/users/current/embed_templates",
      authJson(user.apiKey, "POST", {
        name: "profile template",
        template_svg:
          '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="96" viewBox="0 0 360 96" role="img">' +
          '<text x="12" y="28">{{username}}</text>' +
          '<text x="12" y="54">{{total_time}}</text>' +
          '<text x="12" y="80">{{current_streak}}</text>' +
          "</svg>",
      }),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as { data: { id: string } };

    const res = await call(
      `/api/v1/users/${user.username}/cards/profile.svg?template_id=${body.data.id}`,
    );
    expect(res.status).toBe(200);
    const svg = await res.text();
    expect(svg).toContain("profile_templated");
    expect(svg).toContain("1 hr");
    expect(svg).toContain("1 day");
  });

  it("labels an inverse goal as a cap in the profile card", async () => {
    const user = await seedUser({ username: "profile_inverse_goal" });
    await enableEmbeds(user.apiKey);
    await seedGoal(user.userId, { targetSeconds: 7200, delta: "day", inverse: true });
    await seedSummary(user.userId, formatUtcDate(0), 3600);

    const res = await call(`/api/v1/users/${user.username}/cards/profile.svg?metrics=goal_progress`);
    expect(res.status).toBe(200);
    const svg = await res.text();
    expect(svg).toContain("50% of 2 hrs cap / day");
  });
});

describe("public badges and profile card - privacy", () => {
  it("returns 404 for badges even with a warm cache after embeds are turned OFF", async () => {
    const user = await seedUser({ username: "badge_privacy" });
    await enableEmbeds(user.apiKey);

    const warm = await call(`/api/v1/users/${user.username}/badges/coding_time.svg`);
    expect(warm.status).toBe(200);

    await call(`/api/v1/users/current/embed_settings`, authPatch(user.apiKey, { enabled: false }));

    const res = await call(`/api/v1/users/${user.username}/badges/coding_time.svg`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for the profile card even with a warm cache after embeds are turned OFF", async () => {
    const user = await seedUser({ username: "profile_privacy" });
    await enableEmbeds(user.apiKey);

    const warm = await call(`/api/v1/users/${user.username}/cards/profile.svg`);
    expect(warm.status).toBe(200);

    await call(`/api/v1/users/current/embed_settings`, authPatch(user.apiKey, { enabled: false }));

    const res = await call(`/api/v1/users/${user.username}/cards/profile.svg`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for the profile goal section with a warm cache after the goal is disabled", async () => {
    const user = await seedUser({ username: "profile_goal_disable" });
    await enableEmbeds(user.apiKey);
    const goalId = await seedGoal(user.userId, { targetSeconds: 7200, delta: "day" });
    await seedSummary(user.userId, formatUtcDate(0), 3600);

    const warm = await call(`/api/v1/users/${user.username}/cards/profile.svg?metrics=goal_progress`);
    expect(warm.status).toBe(200);
    expect(await warm.text()).toContain("50% of 2 hrs / day");

    await env.DB.prepare("UPDATE goals SET is_enabled = 0 WHERE id = ?").bind(goalId).run();

    const res = await call(`/api/v1/users/${user.username}/cards/profile.svg?metrics=goal_progress`);
    expect(res.status).toBe(404);
  });

  it("never echoes credentials in badge or profile card output", async () => {
    const user = await seedUser({ username: "badge_secret" });
    await enableEmbeds(user.apiKey);

    const badge = await call(`/api/v1/users/${user.username}/badges/current_streak.svg`);
    expect(badge.status).toBe(200);
    expect(await badge.text()).not.toContain(user.apiKey);

    const profile = await call(`/api/v1/users/${user.username}/cards/profile.svg`);
    expect(profile.status).toBe(200);
    expect(await profile.text()).not.toContain(user.apiKey);
  });
});
