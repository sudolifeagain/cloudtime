import { describe, expect, it } from "vitest";
import {
  base64url,
  decryptToken,
  encryptToken,
  generateApiKey,
  generateCodeChallenge,
  generateCodeVerifier,
  generateNonce,
  generateSessionToken,
  generateState,
  sha256Hex,
  timingSafeEqual,
} from "../../src/utils/crypto";

const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("sha256Hex", () => {
  it("produces 64 lowercase hex chars matching a known vector", async () => {
    // SHA-256("hello") well-known digest
    expect(await sha256Hex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("produces 64 hex chars for arbitrary input", async () => {
    expect(await sha256Hex("")).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256Hex("a longer string with spaces")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("base64url", () => {
  it("encodes binary input as URL-safe base64 with no padding", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa]);
    const encoded = base64url(bytes);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
  });
});

describe("PKCE generation", () => {
  it("produces distinct verifiers across calls", () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThan(30);
  });

  it("derives a stable code_challenge from a given verifier (S256)", async () => {
    const verifier = generateCodeVerifier();
    const c1 = await generateCodeChallenge(verifier);
    const c2 = await generateCodeChallenge(verifier);
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("derives different challenges for different verifiers", async () => {
    const c1 = await generateCodeChallenge(generateCodeVerifier());
    const c2 = await generateCodeChallenge(generateCodeVerifier());
    expect(c1).not.toBe(c2);
  });
});

describe("state / session / nonce / api-key generators", () => {
  it("returns distinct random tokens", () => {
    expect(generateState()).not.toBe(generateState());
    expect(generateSessionToken()).not.toBe(generateSessionToken());
    expect(generateNonce()).not.toBe(generateNonce());
  });

  it("generateApiKey returns UUID plaintext and matching sha256 hash", async () => {
    const { plaintext, hash } = await generateApiKey();
    expect(plaintext).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(hash).toBe(await sha256Hex(plaintext));
  });
});

describe("AES-256-GCM encryptToken / decryptToken", () => {
  it("round-trips plaintext when the same key + context is used", async () => {
    const enc = await encryptToken("super-secret-token", TEST_KEY, "user-123:google");
    const dec = await decryptToken(enc, TEST_KEY, "user-123:google");
    expect(dec).toBe("super-secret-token");
  });

  it("uses a fresh IV per encryption (ciphertexts differ for the same plaintext)", async () => {
    const a = await encryptToken("x", TEST_KEY, "ctx");
    const b = await encryptToken("x", TEST_KEY, "ctx");
    expect(a).not.toBe(b);
  });

  it("fails to decrypt when the AAD context does not match", async () => {
    const enc = await encryptToken("x", TEST_KEY, "user-A:google");
    await expect(decryptToken(enc, TEST_KEY, "user-B:google")).rejects.toThrow();
  });

  it("rejects malformed key lengths", async () => {
    await expect(encryptToken("x", "tooshort", "ctx")).rejects.toThrow(
      /64 hex characters/,
    );
  });

  it("rejects malformed encrypted payload", async () => {
    await expect(decryptToken("not-a-valid-payload", TEST_KEY, "ctx")).rejects.toThrow();
  });
});

describe("timingSafeEqual", () => {
  it("returns true for identical strings", async () => {
    expect(await timingSafeEqual("hello", "hello")).toBe(true);
  });

  it("returns false for different strings of the same length", async () => {
    expect(await timingSafeEqual("hello", "world")).toBe(false);
  });

  it("returns false for strings of different lengths (after hashing they are still distinct)", async () => {
    expect(await timingSafeEqual("a", "ab")).toBe(false);
  });

  it("returns true regardless of input length when the inputs are identical", async () => {
    const longA = "x".repeat(10_000);
    expect(await timingSafeEqual(longA, longA)).toBe(true);
  });
});
