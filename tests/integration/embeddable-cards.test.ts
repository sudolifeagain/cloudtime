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
  await truncate("heartbeats", "summaries", "embed_settings", "users");
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

function formatUtcDate(daysFromToday: number): string {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  today.setUTCDate(today.getUTCDate() + daysFromToday);
  return today.toISOString().slice(0, 10);
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
    expect(svg).toContain("Coding streaks in the last year");
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
    expect(svg).toContain("Coding streaks in the last 7 days");
    expect(svg).toContain("1 hr total coding time");
    expect(svg).not.toContain("3 hrs total coding time");

    const fallback = await call(`/api/v1/users/${user.username}/cards/streak.svg?range=not_supported`);
    expect(fallback.status).toBe(200);
    const fallbackSvg = await fallback.text();
    expect(fallbackSvg).toContain("Coding streaks in the last year");
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
      "INSERT INTO summaries (user_id, date, project, language, total_seconds) VALUES (?, ?, 'cards', 'Go', ?)",
    )
      .bind(user.userId, formatUtcDate(-8), 1800)
      .run();

    const summary = await call(`/api/v1/users/${user.username}/cards/summary.svg?range=last_7_days`);
    expect(summary.status).toBe(200);
    expect(summary.headers.get("Content-Type")).toContain("image/svg+xml");
    const summarySvg = await summary.text();
    expect(summarySvg).toContain("Coding summary in the last 7 days");
    expect(summarySvg).toContain("3 hrs");
    expect(summarySvg).toContain(`${bestDay} / 2 hrs`);
    expect(summarySvg).toContain("TypeScript / 67%");
    expect(summarySvg).not.toContain(user.apiKey);

    const languages = await call(`/api/v1/users/${user.username}/cards/languages.svg?range=last_7_days`);
    expect(languages.status).toBe(200);
    const languagesSvg = await languages.text();
    expect(languagesSvg).toContain("Top languages in the last 7 days");
    expect(languagesSvg).toContain("TypeScript");
    expect(languagesSvg).toContain("67%");
    expect(languagesSvg).toContain("Markdown");
    expect(languagesSvg).toContain("33%");
    expect(languagesSvg).not.toContain("Go");

    const fallback = await call(`/api/v1/users/${user.username}/cards/languages.svg?range=not_supported`);
    expect(fallback.status).toBe(200);
    const fallbackSvg = await fallback.text();
    expect(fallbackSvg).toContain("Top languages in the last year");
    expect(fallbackSvg).toContain("Go");
    expect(fallbackSvg).toContain("3 hrs 30 mins total coding time");
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
