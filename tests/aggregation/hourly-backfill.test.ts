/**
 * One-off hourly_summaries backfill tests (Issue #142).
 *
 * The backfill derives hour-of-day rows from retained raw heartbeats, but never
 * adds to dates that already have hourly rows.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { backfillHourlySummaries } from "../../src/cron/hourly-backfill";
import { seedUser, truncate } from "../helpers/fixtures";

async function seedHeartbeat(userId: string, epochSeconds: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO heartbeats (id, user_id, entity, time) VALUES (?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), userId, "src/main.ts", epochSeconds)
    .run();
}

async function setMeta(key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(key, value)
    .run();
}

async function hourlyRows(userId: string): Promise<{ date: string; hour: number; total_seconds: number }[]> {
  const { results } = await env.DB.prepare(
    `SELECT date, hour, total_seconds
       FROM hourly_summaries
       WHERE user_id = ?
       ORDER BY date, hour`,
  )
    .bind(userId)
    .all<{ date: string; hour: number; total_seconds: number }>();
  return results;
}

async function metaValue(key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

afterEach(async () => {
  await truncate("hourly_backfill_dates", "hourly_summaries", "heartbeats", "meta", "users");
});

describe("backfillHourlySummaries", () => {
  it("waits until the normal aggregation cursor exists", async () => {
    const result = await backfillHourlySummaries(env.DB);
    expect(result).toEqual({ status: "waiting", scannedHeartbeats: 0, insertedRows: 0, cursor: 0 });
  });

  it("backfills missing hourly dates and is idempotent", async () => {
    const user = await seedUser({ username: "backfill_utc", timezone: "UTC" });
    const date1 = Date.UTC(2026, 2, 1, 9, 0, 0) / 1000;
    const date2 = Date.UTC(2026, 2, 2, 11, 0, 0) / 1000;

    await seedHeartbeat(user.userId, date1);
    await seedHeartbeat(user.userId, date1 + 600);
    await seedHeartbeat(user.userId, date1 + 1200);
    await seedHeartbeat(user.userId, date2);
    await seedHeartbeat(user.userId, date2 + 600);

    await env.DB.prepare(
      "INSERT INTO hourly_summaries (user_id, date, hour, total_seconds) VALUES (?, '2026-03-02', 11, 999)",
    )
      .bind(user.userId)
      .run();
    await setMeta("last_aggregated_at", String(date2 + 600));

    const result = await backfillHourlySummaries(env.DB, 100);
    expect(result.status).toBe("complete");
    expect(result.scannedHeartbeats).toBe(5);
    expect(result.insertedRows).toBe(1);
    expect(result.earliestDate).toBe("2026-03-01");
    expect(await metaValue("hourly_backfill_earliest_date")).toBe("2026-03-01");
    expect(await metaValue("hourly_backfill_completed_at")).toBeTruthy();

    expect(await hourlyRows(user.userId)).toEqual([
      { date: "2026-03-01", hour: 9, total_seconds: 1200 },
      { date: "2026-03-02", hour: 11, total_seconds: 999 },
    ]);

    const rerun = await backfillHourlySummaries(env.DB, 100);
    expect(rerun.status).toBe("skipped");
    expect(await hourlyRows(user.userId)).toEqual([
      { date: "2026-03-01", hour: 9, total_seconds: 1200 },
      { date: "2026-03-02", hour: 11, total_seconds: 999 },
    ]);
  });

  it("continues across chunks with a lookback heartbeat", async () => {
    const user = await seedUser({ username: "backfill_chunked", timezone: "UTC" });
    const base = Date.UTC(2026, 4, 1, 13, 0, 0) / 1000;
    for (const offset of [0, 300, 600, 900]) {
      await seedHeartbeat(user.userId, base + offset);
    }
    await setMeta("last_aggregated_at", String(base + 900));

    const first = await backfillHourlySummaries(env.DB, 3);
    expect(first.status).toBe("processed");
    expect(first.cursor).toBe(base + 600);
    expect(await hourlyRows(user.userId)).toEqual([
      { date: "2026-05-01", hour: 13, total_seconds: 600 },
    ]);

    const second = await backfillHourlySummaries(env.DB, 3);
    expect(second.status).toBe("complete");
    expect(await hourlyRows(user.userId)).toEqual([
      { date: "2026-05-01", hour: 13, total_seconds: 900 },
    ]);
  });

  it("uses the user's profile timezone for backfilled dates and hours", async () => {
    const user = await seedUser({ username: "backfill_jst", timezone: "Asia/Tokyo" });
    const t0 = Date.UTC(2026, 2, 13, 23, 0, 0) / 1000;
    await seedHeartbeat(user.userId, t0);
    await seedHeartbeat(user.userId, t0 + 600);
    await setMeta("last_aggregated_at", String(t0 + 600));

    await backfillHourlySummaries(env.DB, 100);

    expect(await hourlyRows(user.userId)).toEqual([
      { date: "2026-03-14", hour: 8, total_seconds: 600 },
    ]);
  });
});
