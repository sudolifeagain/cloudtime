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

  it("returns 404 even with a warm cache after embeds are turned OFF", async () => {
    const user = await seedUser({ username: "bob" });
    await call(`/api/v1/users/current/embed_settings`, authPatch(user.apiKey, { enabled: true }));

    const warm = await call(`/api/v1/users/${user.username}/cards/heatmap.svg`);
    expect(warm.status).toBe(200);

    await call(`/api/v1/users/current/embed_settings`, authPatch(user.apiKey, { enabled: false }));

    const res = await call(`/api/v1/users/${user.username}/cards/heatmap.svg`);
    expect(res.status).toBe(404);
  });

  it("treats summary/languages cards as not-yet-available in P1", async () => {
    const user = await seedUser({ username: "carol" });
    await call(`/api/v1/users/current/embed_settings`, authPatch(user.apiKey, { enabled: true }));

    const summary = await call(`/api/v1/users/${user.username}/cards/summary.svg`);
    expect(summary.status).toBe(404);
    const languages = await call(`/api/v1/users/${user.username}/cards/languages.svg`);
    expect(languages.status).toBe(404);
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
