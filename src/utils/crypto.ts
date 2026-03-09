/**
 * Cryptographic primitives using Web Crypto API (Cloudflare Workers compatible).
 */

// ─── Hashing ─────────────────────────────────────────────

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Raw(input: string): Promise<ArrayBuffer> {
  const data = new TextEncoder().encode(input);
  return crypto.subtle.digest("SHA-256", data);
}

// ─── Random / Encoding ───────────────────────────────────

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlFromBuffer(buf: ArrayBuffer): string {
  return base64url(new Uint8Array(buf));
}

// ─── PKCE ────────────────────────────────────────────────

export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  const hash = await sha256Raw(verifier);
  return base64urlFromBuffer(hash);
}

// ─── Tokens / State ──────────────────────────────────────

export function generateState(): string {
  return base64url(randomBytes(32));
}

export function generateSessionToken(): string {
  return base64url(randomBytes(32));
}

export function generateNonce(): string {
  return base64url(randomBytes(32));
}

export async function generateApiKey(): Promise<{ plaintext: string; hash: string }> {
  const raw = base64url(randomBytes(32));
  const plaintext = `ck_${raw}`;
  const hash = await sha256Hex(plaintext);
  return { plaintext, hash };
}

// ─── AES-256-GCM encryption for OAuth tokens at rest ─────

async function importAesKey(keyHex: string): Promise<CryptoKey> {
  const keyBytes = new Uint8Array(keyHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptToken(plaintext: string, keyHex: string): Promise<string> {
  const key = await importAesKey(keyHex);
  const iv = randomBytes(12);
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return `${base64url(iv)}.${base64urlFromBuffer(ciphertext)}`;
}

export async function decryptToken(encrypted: string, keyHex: string): Promise<string> {
  const key = await importAesKey(keyHex);
  const [ivB64, ctB64] = encrypted.split(".");
  const iv = Uint8Array.from(atob(ivB64.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
  const ciphertext = Uint8Array.from(atob(ctB64.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plainBuf);
}

// ─── Constant-time comparison ────────────────────────────

export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    randomBytes(32),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, aBytes);
  return crypto.subtle.verify("HMAC", key, sig, bBytes);
}
