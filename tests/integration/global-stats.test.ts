/**
 * Integration tests for the unauthenticated global stats endpoint
 * (specs/029-global-stats-utc/): it always aggregates in UTC and ignores any
 * client `timezone`, so the cache key cannot be fragmented (#29).
 */
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/index";
import { truncate } from "../helpers/fixtures";

const BASE = "https://test.cloudtime.dev";

beforeEach(async () => {
  // Mark aggregation recent so the endpoint returns 200 (not 202).
  await env.DB.prepare(
    "INSERT INTO meta (key, value) VALUES ('last_aggregated_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(String(Math.floor(Date.now() / 1000)))
    .run();
});

afterEach(async () => {
  await truncate("meta");
  await env.KV.delete("global-stats:last_7_days");
  await env.KV.delete("global-stats:last_30_days");
});

async function call(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${BASE}${path}`, {}), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

interface GlobalStatsBody {
  data: { range: { timezone: string }; total_seconds: number };
}

describe("GET /api/v1/stats/:range (global, UTC)", () => {
  it("is unauthenticated and reports range.timezone = UTC", async () => {
    const res = await call("/api/v1/stats/last_7_days");
    expect(res.status).toBe(200);
    const body = (await res.json()) as GlobalStatsBody;
    expect(body.data.range.timezone).toBe("UTC");
  });

  it("ignores a client timezone (same payload, still UTC)", async () => {
    const a = (await (await call("/api/v1/stats/last_7_days")).json()) as GlobalStatsBody;
    const b = (await (await call("/api/v1/stats/last_7_days?timezone=Asia/Tokyo")).json()) as GlobalStatsBody;
    expect(a.data.range.timezone).toBe("UTC");
    expect(b.data.range.timezone).toBe("UTC");
    // Different timezones resolve to the same cache key, so the payloads match.
    expect(b.data).toEqual(a.data);
  });

  it("does not reject an invalid timezone (it is ignored)", async () => {
    const res = await call("/api/v1/stats/last_30_days?timezone=Not/AZone");
    expect(res.status).toBe(200);
    expect(((await res.json()) as GlobalStatsBody).data.range.timezone).toBe("UTC");
  });

  it("still 400s on an invalid range", async () => {
    const res = await call("/api/v1/stats/since_forever");
    expect(res.status).toBe(400);
  });
});
