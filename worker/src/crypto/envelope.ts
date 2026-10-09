/**
 * AES-256-GCM envelope for secrets at rest (the users' OCI private keys).
 * The data key comes from the KEY_ENCRYPTION_KEY Worker secret (base64, 32 bytes).
 * Associated data binds each ciphertext to its record (e.g. the account id),
 * so a ciphertext copied to another record fails to decrypt.
 * Wire format (base64): version(1) | iv(12) | ciphertext+tag
 */
import { base64Decode, base64Encode } from "../oci/keys";

const VERSION = 1;
const encoder = new TextEncoder();

export async function importDataKey(secretB64: string): Promise<CryptoKey> {
  const raw = base64Decode(secretB64);
  if (raw.byteLength !== 32) throw new Error("KEY_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(key: CryptoKey, plaintext: Uint8Array, associatedData: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(associatedData) }, key, plaintext),
  );
  const out = new Uint8Array(1 + iv.byteLength + ct.byteLength);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(ct, 1 + iv.byteLength);
  return base64Encode(out);
}

export async function open(key: CryptoKey, sealed: string, associatedData: string): Promise<Uint8Array> {
  const bytes = base64Decode(sealed);
  if (bytes[0] !== VERSION) throw new Error(`Unsupported envelope version ${bytes[0]}`);
  const iv = bytes.subarray(1, 13);
  const ct = bytes.subarray(13);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(associatedData) }, key, ct),
  );
}
