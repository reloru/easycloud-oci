/** Small primitives for sign-in: random tokens, hashes, one-time codes. */
import { base64Decode } from "../oci/keys";

const enc = new TextEncoder();

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Uniform 6-digit code (rejection sampling avoids modulo bias). */
export function sixDigitCode(): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  for (;;) {
    const [n] = crypto.getRandomValues(new Uint32Array(1)) as unknown as [number];
    if (n < limit) return String(n % 1_000_000).padStart(6, "0");
  }
}

/** HMAC key for code hashes, derived from KEY_ENCRYPTION_KEY with HKDF so the AES key is never reused directly. */
export async function codeKey(keyEncryptionKeyB64: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", base64Decode(keyEncryptionKeyB64), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode("eazycloud email code v1") },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
}

export async function codeHash(key: CryptoKey, email: string, code: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${email}\n${code}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
