/**
 * Regression tests for Issue #165: PROVIDER_FETCH_OPTS must be a valid
 * Workers RequestInit. redirect: "error" is not implemented by workerd —
 * fetch()/new Request() throw a TypeError when RequestInit carries it —
 * which made every outbound OAuth provider call (token exchange, user info,
 * JWKS, revocation) fail in production.
 */
import { describe, expect, it } from "vitest";
import { PROVIDER_FETCH_OPTS } from "../../src/utils/oauth";

describe("PROVIDER_FETCH_OPTS (#165)", () => {
  it("is accepted by the Workers Request constructor", () => {
    // This exact construction threw with redirect: "error".
    expect(() => new Request("https://provider.example/", PROVIDER_FETCH_OPTS)).not.toThrow();
  });

  it("never follows redirects (SSRF defense intent preserved)", () => {
    expect(PROVIDER_FETCH_OPTS.redirect).toBe("manual");
  });

  it("attaches a fresh timeout signal per request", () => {
    const a = PROVIDER_FETCH_OPTS.signal;
    const b = PROVIDER_FETCH_OPTS.signal;
    expect(a).toBeInstanceOf(AbortSignal);
    expect(b).not.toBe(a);
  });
});
