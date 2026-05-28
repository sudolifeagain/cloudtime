/**
 * Tests for the heartbeat retention purge (specs/.. Issue #108):
 * parseRetentionDays (pure) + purgeOldHeartbeats against an in-memory D1.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRetentionDays, purgeOldHeartbeats, DEFAULT_PURGE_LIMIT } from "../../src/cron/purge";
import { seedUser, truncate, type SeededUser } from "../helpers/fixtures";

let user: SeededUser;

beforeEach(async () => {
  user = await seedUser({ username: "alice" });
});

afterEach(async () => {
  await truncate("heartbeats", "summaries", "meta", "users");
  await env.KV.delete(`apikey:${user.apiKeyHash}`);
});

const SECONDS_PER_DAY = 86400;
const nowSec = () => Date.now() / 1000;

async function seedHeartbeat(timeSec: number, suffix = ""): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO heartbeats (id, user_id, entity, type, time, is_write, created_at)
     VALUES (?, ?, ?, 'file', ?, 0, datetime('now'))`,
  )
    .bind(crypto.randomUUID(), user.userId, `/e${suffix}.ts`, timeSec)
    .run();
}

async function heartbeatCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM heartbeats").first<{ n: number }>();
  return row?.n ?? 0;
}

async function setLastAggregatedAt(timeSec: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO meta (key, value) VALUES ('last_aggregated_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(String(timeSec))
    .run();
}

describe("parseRetentionDays", () => {
  it("returns null for unset / blank / non-positive / non-numeric values", () => {
    expect(parseRetentionDays(undefined)).toBeNull();
    expect(parseRetentionDays("")).toBeNull();
    expect(parseRetentionDays("   ")).toBeNull();
    expect(parseRetentionDays("0")).toBeNull();
    expect(parseRetentionDays("-5")).toBeNull();
    expect(parseRetentionDays("abc")).toBeNull();
  });

  it("returns the positive number of days", () => {
    expect(parseRetentionDays("90")).toBe(90);
    expect(parseRetentionDays("7")).toBe(7);
    expect(parseRetentionDays("1.5")).toBe(1.5);
  });
});

describe("purgeOldHeartbeats", () => {
  it("deletes heartbeats older than the retention window and keeps recent ones", async () => {
    await setLastAggregatedAt(nowSec());
    await seedHeartbeat(nowSec() - 100 * SECONDS_PER_DAY, "old1"); // 100 days old
    await seedHeartbeat(nowSec() - 91 * SECONDS_PER_DAY, "old2"); // 91 days old
    await seedHeartbeat(nowSec() - 10 * SECONDS_PER_DAY, "recent1"); // 10 days old
    await seedHeartbeat(nowSec(), "recent2"); // now

    const deleted = await purgeOldHeartbeats(env.DB, 90);
    expect(deleted).toBe(2);
    expect(await heartbeatCount()).toBe(2); // the two recent ones remain
  });

  it("is a no-op when retentionDays is non-positive", async () => {
    await setLastAggregatedAt(nowSec());
    await seedHeartbeat(nowSec() - 100 * SECONDS_PER_DAY, "old");
    expect(await purgeOldHeartbeats(env.DB, 0)).toBe(0);
    expect(await purgeOldHeartbeats(env.DB, -1)).toBe(0);
    expect(await heartbeatCount()).toBe(1);
  });

  it("throttles to the per-run limit, clearing a backlog over multiple runs", async () => {
    await setLastAggregatedAt(nowSec());
    for (let i = 0; i < 5; i++) {
      await seedHeartbeat(nowSec() - 100 * SECONDS_PER_DAY, `b${i}`);
    }
    const first = await purgeOldHeartbeats(env.DB, 90, 2);
    expect(first).toBe(2);
    expect(await heartbeatCount()).toBe(3);

    const second = await purgeOldHeartbeats(env.DB, 90, 2);
    expect(second).toBe(2);
    const third = await purgeOldHeartbeats(env.DB, 90, 2);
    expect(third).toBe(1);
    expect(await heartbeatCount()).toBe(0);
  });

  it("does not touch the summaries table", async () => {
    await setLastAggregatedAt(nowSec());
    await seedHeartbeat(nowSec() - 100 * SECONDS_PER_DAY, "old");
    await env.DB.prepare(
      `INSERT INTO summaries (user_id, date, project, total_seconds) VALUES (?, '2026-01-01', 'p', 3600)`,
    )
      .bind(user.userId)
      .run();

    await purgeOldHeartbeats(env.DB, 90);

    const summaries = await env.DB.prepare("SELECT COUNT(*) AS n FROM summaries").first<{ n: number }>();
    expect(summaries?.n).toBe(1);
  });

  it("does not delete heartbeats that are not safely behind the aggregation cursor", async () => {
    const old = nowSec() - 100 * SECONDS_PER_DAY;
    await seedHeartbeat(old, "old");

    expect(await purgeOldHeartbeats(env.DB, 90)).toBe(0);
    expect(await heartbeatCount()).toBe(1);

    await setLastAggregatedAt(old + 30 * 60);
    expect(await purgeOldHeartbeats(env.DB, 90)).toBe(0);
    expect(await heartbeatCount()).toBe(1);

    await setLastAggregatedAt(nowSec());
    expect(await purgeOldHeartbeats(env.DB, 90)).toBe(1);
    expect(await heartbeatCount()).toBe(0);
  });

  it("exposes a sane default per-run limit", () => {
    expect(DEFAULT_PURGE_LIMIT).toBe(1000);
  });
});
