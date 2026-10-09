/**
 * OCI API signing keys: the app generates the key pair; the user pastes the
 * public PEM into Console → API keys ("Paste a public key"). Oracle requires
 * an RSA key in PEM format, minimum 2048 bits.
 * https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm
 */

const RSA_PARAMS = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

export interface GeneratedApiKey {
  /** PKCS#8 DER of the private key — encrypt before storing. */
  privatePkcs8: Uint8Array;
  /** SubjectPublicKeyInfo PEM ("BEGIN PUBLIC KEY") for the Console. */
  publicPem: string;
  /** OCI fingerprint: colon-separated MD5 of the DER public key. */
  fingerprint: string;
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function pemEncode(label: string, der: Uint8Array): string {
  const lines = base64Encode(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

export function pemDecode(pem: string, label: string): Uint8Array {
  const match = new RegExp(`-----BEGIN ${label}-----([\\s\\S]+?)-----END ${label}-----`).exec(pem);
  if (!match?.[1]) throw new Error(`No ${label} found in PEM input`);
  return base64Decode(match[1].replace(/\s+/g, ""));
}

export async function fingerprintFromSpki(spkiDer: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("MD5", spkiDer));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join(":");
}

export async function generateApiKey(): Promise<GeneratedApiKey> {
  const pair = (await crypto.subtle.generateKey(RSA_PARAMS, true, ["sign", "verify"])) as CryptoKeyPair;
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer);
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  return {
    privatePkcs8: pkcs8,
    publicPem: pemEncode("PUBLIC KEY", spki),
    fingerprint: await fingerprintFromSpki(spki),
  };
}

/** Non-extractable signing key from stored PKCS#8 DER. */
export function importSigningKey(pkcs8: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}
