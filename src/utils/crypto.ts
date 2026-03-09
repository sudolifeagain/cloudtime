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
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error("ENCRYPTION_KEY must be exactly 64 hex characters (256 bits)");
  }
  const keyBytes = new Uint8Array(keyHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptToken(plaintext: string, keyHex: string, context?: string): Promise<string> {
  const key = await importAesKey(keyHex);
  const iv = randomBytes(12);
  const encoded = new TextEncoder().encode(plaintext);
  const params: { name: string; iv: Uint8Array; additionalData?: ArrayBuffer | ArrayBufferView } = { name: "AES-GCM", iv };
  if (context) params.additionalData = new TextEncoder().encode(context);
  const ciphertext = await crypto.subtle.encrypt(params, key, encoded);
  return `${base64url(iv)}.${base64urlFromBuffer(ciphertext)}`;
}

function base64urlDecode(input: string): Uint8Array {
  // Restore standard base64: replace URL-safe chars and add padding
  let b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4;
  if (pad === 1) throw new Error("Invalid base64url input");
  if (pad === 2) b64 += "==";
  else if (pad === 3) b64 += "=";
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export async function decryptToken(encrypted: string, keyHex: string, context?: string): Promise<string> {
  const key = await importAesKey(keyHex);
  const parts = encrypted.split(".");
  if (parts.length !== 2) throw new Error("Invalid encrypted token format");
  const iv = base64urlDecode(parts[0]);
  if (iv.length !== 12) throw new Error("Invalid encrypted token format");
  const ciphertext = base64urlDecode(parts[1]);
  const params: { name: string; iv: Uint8Array; additionalData?: ArrayBuffer | ArrayBufferView } = { name: "AES-GCM", iv };
  if (context) params.additionalData = new TextEncoder().encode(context);
  const plainBuf = await crypto.subtle.decrypt(params, key, ciphertext);
  return new TextDecoder().decode(plainBuf);
}

// ─── Constant-time comparison ────────────────────────────

export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(aHash, bHash);
}
