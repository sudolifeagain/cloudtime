/**
 * Integration tests for the dashboard AI model-attribution guidance (Issue #201,
 * US1/US2). Renders the real owner dashboard (`GET /app`, session-cookie auth)
 * against in-memory D1 and asserts the guided setup step shows only when recent
 * usage is provider-known / model-unknown, and hides otherwise. Mirrors the setup
 * in `app-ai-pricing.test.ts`.
 */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { seedUserWithSession, truncate } from "../helpers/fixtures";

const BASE = "https://test.cloudtime.dev";
/** Unique to the tailored Codex guidance — a reliable present/absent marker. */
const GUIDANCE_MARKER = "node scripts/patch-codex-wakatime.mjs";

afterEach(async () => {
  await truncate("ai_daily_usage", "sessions", "users");
  const keys = await env.KV.list();
  await Promise.all(keys.keys.map((key) => env.KV.delete(key.name)));
});

/** `YYYY-MM-DD` in UTC, `offsetDays` from today (negative = past). */
function utcDay(offsetDays = 0): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offsetDays * 86_400_000));
}

async function seedUsage(
  userId: string,
  row: { day: string; provider: string; model: string; heartbeats?: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ai_daily_usage
       (user_id, day, provider, model, agent, project, input_tokens, heartbeat_count)
     VALUES (?, ?, ?, ?, 'codex-cli', 'cloudtime', 1000, ?)`,
  )
    .bind(userId, row.day, row.provider, row.model, row.heartbeats ?? 2)
    .run();
}

async function getDashboard(sessionToken: string): Promise<string> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${BASE}/app`, { headers: { Cookie: `__Host-session=${sessionToken}` } }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return res.text();
}

describe("dashboard AI attribution guidance", () => {
  it("shows the Codex setup guidance for recent openai/unknown usage", async () => {
    const user = await seedUserWithSession({ username: "owner", timezone: "UTC" });
    // The rollup stores the literal "unknown" sentinel for a null model.
    await seedUsage(user.userId, { day: utcDay(0), provider: "openai", model: "unknown", heartbeats: 2 });

    const html = await getDashboard(user.sessionToken);
    expect(html).toContain(GUIDANCE_MARKER);
    expect(html).toContain("codex-model-attribution.md");
    expect(html).toContain("Codex");
  });

  it("hides the guidance when usage already carries a concrete model", async () => {
    const user = await seedUserWithSession({ username: "owner", timezone: "UTC" });
    await seedUsage(user.userId, {
      day: utcDay(0),
      provider: "anthropic",
      model: "claude-opus-4-8",
      heartbeats: 5,
    });

    const html = await getDashboard(user.sessionToken);
    expect(html).toContain("Token usage"); // AI panel rendered
    expect(html).not.toContain(GUIDANCE_MARKER);
  });

  it("does not nag on out-of-window historical unknowns", async () => {
    const user = await seedUserWithSession({ username: "owner", timezone: "UTC" });
    // In-window attributed usage keeps the AI panel populated...
    await seedUsage(user.userId, {
      day: utcDay(0),
      provider: "anthropic",
      model: "claude-opus-4-8",
      heartbeats: 5,
    });
    // ...while an old openai/unknown row sits outside the trailing ~30-day window.
    await seedUsage(user.userId, { day: utcDay(-45), provider: "openai", model: "unknown", heartbeats: 9 });

    const html = await getDashboard(user.sessionToken);
    expect(html).not.toContain(GUIDANCE_MARKER);
  });

  it("does not show guidance for an owner with no AI usage", async () => {
    const user = await seedUserWithSession({ username: "owner", timezone: "UTC" });
    const html = await getDashboard(user.sessionToken);
    expect(html).not.toContain(GUIDANCE_MARKER);
  });
});
