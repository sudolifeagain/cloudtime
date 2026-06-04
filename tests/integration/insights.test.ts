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
  await truncate("hourly_summaries", "summaries", "users");
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

async function seedHourly(opts: {
  userId: string;
  date: string;
  hour: number;
  totalSeconds: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO hourly_summaries (user_id, date, hour, total_seconds) VALUES (?, ?, ?, ?)`,
  )
    .bind(opts.userId, opts.date, opts.hour, opts.totalSeconds)
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

describe("GET /insights/days/:range?weekday= (filter)", () => {
  // 2026-03-02 & 2026-03-09 are Mondays; 2026-03-03 is a Tuesday.
  async function seedDaysFixture(): Promise<void> {
    await seedSummary({ userId: user.userId, date: "2026-03-02", project: "p", totalSeconds: 3600 }); // Mon
    await seedSummary({ userId: user.userId, date: "2026-03-09", project: "p", totalSeconds: 5400 }); // Mon
    await seedSummary({ userId: user.userId, date: "2026-03-03", project: "p", totalSeconds: 1800 }); // Tue
  }

  async function dayDates(query: string): Promise<{ status: number; dates: string[] }> {
    const res = await call(`${INSIGHTS}/days/${YEAR}${query}`, { headers: bearer(user.apiKey) });
    if (res.status !== 200) return { status: res.status, dates: [] };
    const { data } = (await res.json()) as { data: { days: { date: string }[] } };
    return { status: res.status, dates: data.days.map((d) => d.date) };
  }

  it("filters by weekday name", async () => {
    await seedDaysFixture();
    expect((await dayDates("?weekday=monday")).dates).toEqual(["2026-03-02", "2026-03-09"]);
  });

  it("integer and name are equivalent, case-insensitively", async () => {
    await seedDaysFixture();
    const byInt = await dayDates("?weekday=1");
    const byName = await dayDates("?weekday=monday");
    const byCaps = await dayDates("?weekday=MONDAY");
    expect(byInt.dates).toEqual(["2026-03-02", "2026-03-09"]);
    expect(byName.dates).toEqual(byInt.dates);
    expect(byCaps.dates).toEqual(byInt.dates);
  });

  it("returns a single matching day, and empty when none match", async () => {
    await seedDaysFixture();
    expect((await dayDates("?weekday=tuesday")).dates).toEqual(["2026-03-03"]);
    expect((await dayDates("?weekday=saturday")).dates).toEqual([]);
  });

  it("400s on an invalid weekday for the days type", async () => {
    await seedDaysFixture();
    expect((await dayDates("?weekday=funday")).status).toBe(400);
    expect((await dayDates("?weekday=7")).status).toBe(400);
    expect((await dayDates("?weekday=")).status).toBe(400);
  });

  it("is ignored by non-`days` insight types (valid or invalid value)", async () => {
    await seedSummary({ userId: user.userId, date: "2026-03-02", language: "TypeScript", totalSeconds: 3600 }); // Mon
    await seedSummary({ userId: user.userId, date: "2026-03-03", language: "Go", totalSeconds: 1800 }); // Tue

    const names = async (path: string): Promise<{ status: number; names: string[] }> => {
      const r = await call(path, { headers: bearer(user.apiKey) });
      const body = (await r.json()) as { data: { items: { name: string }[] } };
      return { status: r.status, names: body.data.items.map((i) => i.name) };
    };

    const plain = await names(`${INSIGHTS}/languages/${YEAR}`);
    const filtered = await names(`${INSIGHTS}/languages/${YEAR}?weekday=monday`);
    const bogus = await names(`${INSIGHTS}/languages/${YEAR}?weekday=funday`);
    expect(filtered.status).toBe(200);
    expect(bogus.status).toBe(200);
    expect(filtered.names).toEqual(plain.names);
    expect(bogus.names).toEqual(plain.names);
  });
});

describe("GET /insights/hours/:range", () => {
  type HoursBucket = { hour: number; total_seconds: number; text: string };

  // Two active days: hour 9 spans both, hours 10 and 14 on one day each.
  async function seedHoursFixture(): Promise<void> {
    await seedHourly({ userId: user.userId, date: "2026-03-01", hour: 9, totalSeconds: 3600 });
    await seedHourly({ userId: user.userId, date: "2026-03-01", hour: 10, totalSeconds: 1800 });
    await seedHourly({ userId: user.userId, date: "2026-03-02", hour: 9, totalSeconds: 1800 });
    await seedHourly({ userId: user.userId, date: "2026-03-02", hour: 14, totalSeconds: 600 });
  }

  async function getHours(path: string): Promise<{ status: number; buckets: HoursBucket[] }> {
    const res = await call(path, { headers: bearer(user.apiKey) });
    if (res.status !== 200) return { status: res.status, buckets: [] };
    const { data } = (await res.json()) as { data: { type: string; hours: HoursBucket[] } };
    return { status: res.status, buckets: data.hours };
  }

  it("returns a 24-bucket profile of mean coding time per hour", async () => {
    await seedHoursFixture();
    const { status, buckets } = await getHours(`${INSIGHTS}/hours/${YEAR}`);
    expect(status).toBe(200);
    expect(buckets).toHaveLength(24);
    expect(buckets.map((b) => b.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    const byHour = new Map(buckets.map((b) => [b.hour, b.total_seconds]));
    expect(byHour.get(9)).toBe(2700); // (3600 + 1800) / 2 active days
    expect(byHour.get(10)).toBe(900); // 1800 / 2
    expect(byHour.get(14)).toBe(300); // 600 / 2
    expect(byHour.get(0)).toBe(0);
  });

  it("the 24 buckets sum to the daily_average for the same range", async () => {
    await seedHoursFixture();
    // Same activity expressed as daily summaries: 2026-03-01 = 5400, 2026-03-02 = 2400.
    await seedSummary({ userId: user.userId, date: "2026-03-01", project: "p", totalSeconds: 5400 });
    await seedSummary({ userId: user.userId, date: "2026-03-02", project: "p", totalSeconds: 2400 });

    const { buckets } = await getHours(`${INSIGHTS}/hours/${YEAR}`);
    const sum = buckets.reduce((acc, b) => acc + b.total_seconds, 0);

    const avgRes = await call(`${INSIGHTS}/daily_average/${YEAR}`, { headers: bearer(user.apiKey) });
    const avg = ((await avgRes.json()) as { data: { daily_average: { seconds: number } } }).data.daily_average.seconds;
    expect(sum).toBe(avg);
    expect(sum).toBe(3900);
  });

  it("returns 24 zero buckets for an empty range", async () => {
    const { status, buckets } = await getHours(`${INSIGHTS}/hours/2099`);
    expect(status).toBe(200);
    expect(buckets).toHaveLength(24);
    expect(buckets.every((b) => b.total_seconds === 0)).toBe(true);
  });

  it("accepts year, month, and named ranges", async () => {
    await seedHoursFixture();
    expect((await getHours(`${INSIGHTS}/hours/2026-03`)).status).toBe(200);
    expect((await getHours(`${INSIGHTS}/hours/last_7_days`)).status).toBe(200);
    expect((await getHours(`${INSIGHTS}/hours/2026-03`)).buckets).toHaveLength(24);
  });

  it("400s on an invalid range and 401s when unauthenticated", async () => {
    const bad = await call(`${INSIGHTS}/hours/since_forever`, { headers: bearer(user.apiKey) });
    expect(bad.status).toBe(400);
    const unauth = await call(`${INSIGHTS}/hours/${YEAR}`);
    expect(unauth.status).toBe(401);
  });

  it("ignores the weekday / timeout / writes_only query params", async () => {
    await seedHoursFixture();
    const plain = await getHours(`${INSIGHTS}/hours/${YEAR}`);
    const withParams = await getHours(`${INSIGHTS}/hours/${YEAR}?weekday=monday&timeout=30&writes_only=true`);
    expect(withParams.status).toBe(200);
    expect(withParams.buckets).toEqual(plain.buckets);
  });

  it("isolates results per user", async () => {
    await seedHoursFixture();
    const bob = await seedUser({ username: "bob_hours", email: "bobhours@example.test" });
    await seedHourly({ userId: bob.userId, date: "2026-03-01", hour: 3, totalSeconds: 9999 });

    const { buckets } = await getHours(`${INSIGHTS}/hours/${YEAR}`);
    // Bob's hour-3 activity must not leak into Alice's profile.
    expect(buckets.find((b) => b.hour === 3)?.total_seconds).toBe(0);
    await env.KV.delete(`apikey:${bob.apiKeyHash}`);
  });
});
