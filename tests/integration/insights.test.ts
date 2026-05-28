/**
 * Integration tests for the Insights endpoint (specs/103-insights/).
 * Seeds `summaries` directly and exercises each insight type, validation,
 * cross-user isolation, and auth.
 */
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { seedUser, truncate, type SeededUser } from "../helpers/fixtures";

const BASE = "https://test.cloudtime.dev";
const INSIGHTS = "/api/v1/users/current/insights";

let user: SeededUser;

beforeEach(async () => {
  user = await seedUser({ username: "alice", email: "alice@example.test", timezone: "UTC" });
});

afterEach(async () => {
  await truncate("summaries", "users");
  await env.KV.delete(`apikey:${user.apiKeyHash}`);
});

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function bearer(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

async function seedSummary(opts: {
  userId: string;
  date: string;
  totalSeconds: number;
  language?: string;
  editor?: string;
  project?: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO summaries (user_id, date, project, language, editor, total_seconds)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      opts.userId,
      opts.date,
      opts.project ?? null,
      opts.language ?? null,
      opts.editor ?? null,
      opts.totalSeconds,
    )
    .run();
}

// Use a fixed historical year so the data is inside the `2026` range regardless
// of when the suite runs.
const YEAR = "2026";

describe("GET /insights/:insight_type/:range", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await call(`${INSIGHTS}/languages/last_7_days`);
    expect(res.status).toBe(401);
  });

  it("400s on an invalid insight_type", async () => {
    const res = await call(`${INSIGHTS}/bogus/${YEAR}`, { headers: bearer(user.apiKey) });
    expect(res.status).toBe(400);
  });

  it("400s on an invalid range", async () => {
    const res = await call(`${INSIGHTS}/languages/since_forever`, { headers: bearer(user.apiKey) });
    expect(res.status).toBe(400);
  });

  it("languages: grouped, ordered desc, with range echoed", async () => {
    await seedSummary({ userId: user.userId, date: "2026-03-01", language: "TypeScript", totalSeconds: 7200 });
    await seedSummary({ userId: user.userId, date: "2026-03-02", language: "Go", totalSeconds: 3600 });

    const res = await call(`${INSIGHTS}/languages/${YEAR}`, { headers: bearer(user.apiKey) });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { type: string; range: { start: string; end: string; text: string }; items: { name: string }[] };
    };
    expect(data.type).toBe("languages");
    expect(data.range.text).toBe("2026");
    expect(data.range.start).toBe("2026-01-01T00:00:00Z");
    expect(data.range.end).toBe("2026-12-31T23:59:59Z");
    expect(data.items.map((i) => i.name)).toEqual(["TypeScript", "Go"]);
  });

  it("best_day / daily_average / days over a year range", async () => {
    await seedSummary({ userId: user.userId, date: "2026-03-01", project: "p", totalSeconds: 3600 });
    await seedSummary({ userId: user.userId, date: "2026-03-02", project: "p", totalSeconds: 5400 });

    const best = await call(`${INSIGHTS}/best_day/${YEAR}`, { headers: bearer(user.apiKey) });
    expect(((await best.json()) as { data: { best_day: { date: string } } }).data.best_day.date).toBe("2026-03-02");

    const avg = await call(`${INSIGHTS}/daily_average/${YEAR}`, { headers: bearer(user.apiKey) });
    expect(((await avg.json()) as { data: { daily_average: { seconds: number } } }).data.daily_average.seconds).toBe(4500);

    const days = await call(`${INSIGHTS}/days/${YEAR}`, { headers: bearer(user.apiKey) });
    expect(((await days.json()) as { data: { days: { date: string }[] } }).data.days.map((d) => d.date)).toEqual([
      "2026-03-01",
      "2026-03-02",
    ]);
  });

  it("empty range returns 200 with empty/zeroed payloads", async () => {
    const items = await call(`${INSIGHTS}/languages/2099`, { headers: bearer(user.apiKey) });
    expect(items.status).toBe(200);
    expect(((await items.json()) as { data: { items: unknown[] } }).data.items).toEqual([]);

    const avg = await call(`${INSIGHTS}/daily_average/2099`, { headers: bearer(user.apiKey) });
    expect(((await avg.json()) as { data: { daily_average: { seconds: number } } }).data.daily_average.seconds).toBe(0);
  });

  it("isolates results per user", async () => {
    const bob = await seedUser({ username: "bob", email: "bob@example.test" });
    await seedSummary({ userId: bob.userId, date: "2026-03-01", language: "Rust", totalSeconds: 9999 });

    const res = await call(`${INSIGHTS}/languages/${YEAR}`, { headers: bearer(user.apiKey) });
    expect(((await res.json()) as { data: { items: unknown[] } }).data.items).toEqual([]);

    await env.KV.delete(`apikey:${bob.apiKeyHash}`);
  });
});
