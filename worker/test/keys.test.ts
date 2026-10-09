import { describe, expect, it } from "vitest";
import { fingerprintFromSpki, generateApiKey, importSigningKey, pemDecode } from "../src/oci/keys";
import { signRequest } from "../src/oci/signer";
import ref from "./fixtures/signer-reference.json";

describe("fingerprintFromSpki", () => {
  it("matches the OCI fingerprint computed by the Python reference (MD5 of DER SPKI)", async () => {
    expect(await fingerprintFromSpki(pemDecode(ref.publicKeyPem, "PUBLIC KEY"))).toBe(ref.fingerprint);
  });
});

describe("generateApiKey", () => {
  it("produces a 2048-bit RSA public PEM, a matching fingerprint, and a usable signing key", async () => {
    const key = await generateApiKey();
    expect(key.publicPem).toMatch(/^-----BEGIN PUBLIC KEY-----\n(?:[A-Za-z0-9+/=]{64}\n)+[A-Za-z0-9+/=]{1,64}\n-----END PUBLIC KEY-----\n$/);
    const spki = pemDecode(key.publicPem, "PUBLIC KEY");
    expect(await fingerprintFromSpki(spki)).toBe(key.fingerprint);
    const pub = await crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["verify"]);
    expect((pub.algorithm as { modulusLength?: number }).modulusLength).toBe(2048);

    const signed = await signRequest(
      { method: "GET", url: "https://identity.us-ashburn-1.oraclecloud.com/20160918/regions" },
      { tenancyOcid: "t", userOcid: "u", fingerprint: key.fingerprint, privateKey: await importSigningKey(key.privatePkcs8) },
    );
    const sig = /signature="([^"]+)"/.exec(signed.headers.get("authorization")!)![1]!;
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", pub, Uint8Array.from(atob(sig), (c) => c.charCodeAt(0)), new TextEncoder().encode(signed.signingString),
    );
    expect(ok).toBe(true);
  });

  it("generates a different key each time", async () => {
    const [a, b] = await Promise.all([generateApiKey(), generateApiKey()]);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});
