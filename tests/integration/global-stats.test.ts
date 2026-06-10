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
import { seedUser, truncate } from "../helpers/fixtures";

const BASE = "https://test.cloudtime.dev";
const CACHE_KEYS = [
  "global-stats:last_7_days",
  "global-stats:last_7_days:UTC",
  "global-stats:last_7_days:Asia/Tokyo",
  "global-stats:last_30_days",
  "global-stats:last_30_days:Not/AZone",
];

async function clearGlobalStatsCache(): Promise<void> {
  await Promise.all(CACHE_KEYS.map((key) => env.KV.delete(key)));
}

beforeEach(async () => {
  await clearGlobalStatsCache();
  // Mark aggregation recent so the endpoint returns 200 (not 202).
  await env.DB.prepare(
    "INSERT INTO meta (key, value) VALUES ('last_aggregated_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  )
    .bind(String(Math.floor(Date.now() / 1000)))
    .run();
});

afterEach(async () => {
  await truncate("meta");
  await clearGlobalStatsCache();
});

async function call(
  path: string,
  init: RequestInit = {},
  envOverrides: Partial<Cloudflare.Env> = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const testEnv = { ...env, ...envOverrides };
  const res = await worker.fetch(new Request(`${BASE}${path}`, init), testEnv, ctx);
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
    expect(await env.KV.get("global-stats:last_7_days", "json")).not.toBeNull();
    expect(await env.KV.get("global-stats:last_7_days:UTC", "json")).toBeNull();
    expect(await env.KV.get("global-stats:last_7_days:Asia/Tokyo", "json")).toBeNull();
  });

  it("does not reject an invalid timezone (it is ignored)", async () => {
    const res = await call("/api/v1/stats/last_30_days?timezone=Not/AZone");
    expect(res.status).toBe(200);
    expect(((await res.json()) as GlobalStatsBody).data.range.timezone).toBe("UTC");
    expect(await env.KV.get("global-stats:last_30_days", "json")).not.toBeNull();
    expect(await env.KV.get("global-stats:last_30_days:Not/AZone", "json")).toBeNull();
  });

  it("still 400s on an invalid range", async () => {
    const res = await call("/api/v1/stats/since_forever");
    expect(res.status).toBe(400);
  });
});

describe("PUBLIC_STATS instance switch (#156)", () => {
  const DISABLED = { PUBLIC_STATS: "false" };

  it("disabled: returns 404 for a valid range and writes no cache entry", async () => {
    const res = await call("/api/v1/stats/last_7_days", {}, DISABLED);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await env.KV.get("global-stats:last_7_days", "json")).toBeNull();
  });

  it("disabled: invalid range returns an identical 404, not 400 (FR-002)", async () => {
    const valid = await call("/api/v1/stats/last_7_days", {}, DISABLED);
    const invalid = await call("/api/v1/stats/since_forever", {}, DISABLED);
    expect(valid.status).toBe(404);
    expect(invalid.status).toBe(404);
    // Identical bodies so probing cannot distinguish disabled from absent.
    expect(await invalid.json()).toEqual(await valid.json());
  });

  it("disabled: does not serve an entry cached while enabled (FR-003)", async () => {
    // Populate the cache via an enabled request, then flip the switch.
    expect((await call("/api/v1/stats/last_7_days")).status).toBe(200);
    expect(await env.KV.get("global-stats:last_7_days", "json")).not.toBeNull();

    const res = await call("/api/v1/stats/last_7_days", {}, DISABLED);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("enabled explicitly or with an unrecognized value: behavior unchanged (FR-001/FR-005)", async () => {
    for (const value of ["true", "no", " FALSE-ish "]) {
      await clearGlobalStatsCache();
      const ok = await call("/api/v1/stats/last_7_days", {}, { PUBLIC_STATS: value });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as GlobalStatsBody).data.range.timezone).toBe("UTC");
      expect(await env.KV.get("global-stats:last_7_days", "json")).not.toBeNull();

      const bad = await call("/api/v1/stats/since_forever", {}, { PUBLIC_STATS: value });
      expect(bad.status).toBe(400);
    }
  });

  it("disabled: case-insensitive with surrounding whitespace", async () => {
    const res = await call("/api/v1/stats/last_7_days", {}, { PUBLIC_STATS: " False " });
    expect(res.status).toBe(404);
  });

  it("disabled: other public endpoints are unaffected (FR-006)", async () => {
    for (const path of ["/api/v1/health", "/api/v1/meta", "/api/v1/editors", "/api/v1/program_languages"]) {
      const res = await call(path, {}, DISABLED);
      expect(res.status).toBe(200);
    }
  });

  it("disabled: authenticated per-user stats are unaffected (FR-006)", async () => {
    const user = await seedUser();
    try {
      const res = await call(
        "/api/v1/users/current/stats/last_7_days",
        { headers: { Authorization: `Bearer ${user.apiKey}` } },
        DISABLED,
      );
      expect(res.status).toBe(200);
    } finally {
      await env.KV.delete(`apikey:${user.apiKeyHash}`);
      await truncate("users");
    }
  });
});
