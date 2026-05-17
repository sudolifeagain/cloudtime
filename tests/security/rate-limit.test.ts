/**
 * Tests for src/middleware/rate-limit.ts. Mounts the middleware on a
 * throwaway Hono app and observes the `key` argument passed to a
 * fake RateLimit binding to verify IP truncation behaviour.
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { rateLimitMiddleware } from "../../src/middleware/rate-limit";
import type { Env, RateLimit } from "../../src/types";

interface FakeRateLimit extends RateLimit {
  readonly keys: string[];
}

function fakeBinding(decision: { success: boolean }): FakeRateLimit {
  const keys: string[] = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      return decision;
    },
  };
}

function buildApp(binding: RateLimit | undefined) {
  const app = new Hono<{ Bindings: Env }>();
  app.get(
    "/ping",
    rateLimitMiddleware(() => binding, "test-endpoint", "TEST_RULE"),
    (c) => c.json({ ok: true }),
  );
  return app;
}

const sharedEnv = {} as Env;

async function call(
  app: Hono<{ Bindings: Env }>,
  headers: Record<string, string>,
  env: Env = sharedEnv,
) {
  return app.request("/ping", { headers }, env);
}

describe("rate-limit middleware — IP key derivation", () => {
  it("truncates IPv4 to /24 using CF-Connecting-IP", async () => {
    const binding = fakeBinding({ success: true });
    const app = buildApp(binding);

    const res = await call(app, { "CF-Connecting-IP": "203.0.113.42" });

    expect(res.status).toBe(200);
    expect(binding.keys).toEqual(["203.0.113.0/24"]);
  });

  it("truncates IPv6 to /48 with lower-case normalisation", async () => {
    const binding = fakeBinding({ success: true });
    const app = buildApp(binding);

    await call(app, { "CF-Connecting-IP": "2001:DB8:ABCD:1234::1" });

    expect(binding.keys).toEqual(["2001:db8:abcd::/48"]);
  });

  it("derives a single /48 key from any /128 inside the same /48", async () => {
    const binding = fakeBinding({ success: true });
    const app = buildApp(binding);

    await call(app, { "CF-Connecting-IP": "2001:db8:abcd:1234::1" });
    await call(app, { "CF-Connecting-IP": "2001:db8:abcd:ffff:1:2:3:4" });

    expect(new Set(binding.keys)).toEqual(new Set(["2001:db8:abcd::/48"]));
  });

  it("falls back to the first X-Forwarded-For hop when CF-Connecting-IP is absent", async () => {
    const binding = fakeBinding({ success: true });
    const app = buildApp(binding);

    await call(app, {
      "X-Forwarded-For": "198.51.100.7, 198.51.100.99, 10.0.0.1",
    });

    expect(binding.keys).toEqual(["198.51.100.0/24"]);
  });

  it("uses the literal \"unknown\" key when no IP header is present", async () => {
    const binding = fakeBinding({ success: true });
    const app = buildApp(binding);

    await call(app, {});

    expect(binding.keys).toEqual(["unknown"]);
  });

  it("strips IPv6 brackets and zone identifiers before truncation", async () => {
    const binding = fakeBinding({ success: true });
    const app = buildApp(binding);

    await call(app, { "CF-Connecting-IP": "[2001:db8:abcd:1234::1]" });
    await call(app, { "CF-Connecting-IP": "2001:db8:abcd:1234::1%eth0" });

    expect(binding.keys).toEqual([
      "2001:db8:abcd::/48",
      "2001:db8:abcd::/48",
    ]);
  });
});

describe("rate-limit middleware — decision handling", () => {
  it("calls next() and returns 200 when the binding reports success", async () => {
    const app = buildApp(fakeBinding({ success: true }));

    const res = await call(app, { "CF-Connecting-IP": "203.0.113.42" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 429 with Retry-After and no-store headers when the binding rejects", async () => {
    const app = buildApp(fakeBinding({ success: false }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await call(app, { "CF-Connecting-IP": "203.0.113.42" });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Pragma")).toBe("no-cache");
    expect(await res.json()).toEqual({ error: "Too many requests" });
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("rejected");
    expect(warnSpy.mock.calls[0][0]).toContain("203.0.113.0/24");

    warnSpy.mockRestore();
  });

  it("fails open and warns exactly once per env when the binding is undefined", async () => {
    const app = buildApp(undefined);
    const env = {} as Env; // fresh env — first warning expected
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res1 = await call(app, { "CF-Connecting-IP": "203.0.113.42" }, env);
    const res2 = await call(app, { "CF-Connecting-IP": "203.0.113.42" }, env);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    // WeakSet keyed on env: same env reference, so the warn happens once.
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });
});
