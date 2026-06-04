/**
 * Cron aggregation tests for the hour-of-day pre-aggregate (Issue #134).
 * Seeds raw heartbeats, runs `aggregateHeartbeats`, and asserts that
 * `hourly_summaries` is populated alongside `summaries` from a single pass.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { aggregateHeartbeats } from "../../src/cron/aggregate";
import { seedUser, truncate } from "../helpers/fixtures";

async function seedHeartbeat(userId: string, epochSeconds: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO heartbeats (id, user_id, entity, time) VALUES (?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), userId, "src/main.ts", epochSeconds)
    .run();
}

async function hourlyRows(userId: string): Promise<{ date: string; hour: number; total_seconds: number }[]> {
  const { results } = await env.DB.prepare(
    `SELECT date, hour, total_seconds FROM hourly_summaries WHERE user_id = ? ORDER BY date, hour`,
  )
    .bind(userId)
    .all<{ date: string; hour: number; total_seconds: number }>();
  return results;
}

afterEach(async () => {
  await truncate("hourly_summaries", "summaries", "heartbeats", "meta", "users");
});

describe("aggregateHeartbeats - hour-of-day aggregate", () => {
  it("buckets durations into hour-of-day (UTC) alongside the daily summary", async () => {
    const user = await seedUser({ username: "hourly_utc", timezone: "UTC" });

    // 2026-03-02: two sub-timeout gaps in hour 9 (600 + 600), an idle gap
    // (> 15 min default timeout) that is dropped, then one gap in hour 10 (420).
    const base = Date.UTC(2026, 2, 2, 9, 0, 0) / 1000;
    await seedHeartbeat(user.userId, base); // 09:00
    await seedHeartbeat(user.userId, base + 600); // 09:10  -> +600 to hour 9
    await seedHeartbeat(user.userId, base + 1200); // 09:20 -> +600 to hour 9
    await seedHeartbeat(user.userId, base + 3900); // 10:05 (gap 2700 > timeout, dropped)
    await seedHeartbeat(user.userId, base + 4320); // 10:12 -> +420 to hour 10

    await aggregateHeartbeats(env.DB);

    expect(await hourlyRows(user.userId)).toEqual([
      { date: "2026-03-02", hour: 9, total_seconds: 1200 },
      { date: "2026-03-02", hour: 10, total_seconds: 420 },
    ]);

    // The daily summary captures the same total from the same pass.
    const daily = await env.DB.prepare(
      `SELECT date, SUM(total_seconds) AS total FROM summaries WHERE user_id = ? GROUP BY date`,
    )
      .bind(user.userId)
      .first<{ date: string; total: number }>();
    expect(daily).toEqual({ date: "2026-03-02", total: 1620 });

    // The cursor advanced to the latest heartbeat time.
    const cursor = await env.DB.prepare(
      `SELECT value FROM meta WHERE key = 'last_aggregated_at'`,
    ).first<{ value: string }>();
    expect(Number(cursor?.value)).toBe(base + 4320);
  });

  it("buckets the hour in the user's profile timezone", async () => {
    const user = await seedUser({ username: "hourly_jst", timezone: "Asia/Tokyo" });

    // 2026-03-13 23:00 & 23:10 UTC = 2026-03-14 08:00 & 08:10 JST (UTC+9).
    const t0 = Date.UTC(2026, 2, 13, 23, 0, 0) / 1000;
    await seedHeartbeat(user.userId, t0);
    await seedHeartbeat(user.userId, t0 + 600);

    await aggregateHeartbeats(env.DB);

    expect(await hourlyRows(user.userId)).toEqual([
      { date: "2026-03-14", hour: 8, total_seconds: 600 },
    ]);
  });
});
