import { describe, expect, it } from "vitest";
import { httpDate, importPrivateKeyPem, signRequest, type OciCredentials } from "../src/oci/signer";
import ref from "./fixtures/signer-reference.json";

// Oracle's documented GET example signing string ("Request Signatures" page), with the
// display-only line breaks removed. The page's example signatures are placeholders, so
// signature bytes are checked against the Python SDK reference fixture instead.
const DOC_GET_SIGNING_STRING = [
  "date: Thu, 05 Jan 2014 21:31:40 GMT",
  "(request-target): get /20160918/instances?availabilityDomain=Pjwf%3A%20PHX-AD-1" +
    "&compartmentId=ocid1.compartment.oc1..aaaaaaaam3we6vgnherjq5q2idnccdflvjsnog7mlr6rtdb25gilchfeyjxa" +
    "&displayName=TeamXInstances" +
    "&volumeId=ocid1.volume.oc1.phx.abyhqljrgvttnlx73nmrwfaux7kcvzfs3s66izvxf2h4lgvyndsdsnoiwr5q",
  "host: iaas.us-phoenix-1.oraclecloud.com",
].join("\n");

// Oracle's published sample key from the same page (PKCS#1, 1024-bit) — must be rejected.
const ORACLE_DOC_PKCS1_HEADER = "-----BEGIN RSA PRIVATE KEY-----\nMIICXgIBAAKBgQDCFENGw33yGihy92pDjZQhl0C3\n-----END RSA PRIVATE KEY-----";

async function creds(): Promise<OciCredentials> {
  return {
    tenancyOcid: ref.tenancy,
    userOcid: ref.user,
    fingerprint: ref.fingerprint,
    privateKey: await importPrivateKeyPem(ref.privateKeyPem),
  };
}

describe("signRequest", () => {
  it("reproduces Oracle's documented GET signing string exactly", async () => {
    const doc = ref.cases.find((c) => c.name === "get-doc-example")!;
    const signed = await signRequest({ method: "GET", url: doc.url, headers: { date: doc.date } }, await creds());
    expect(signed.signingString).toBe(DOC_GET_SIGNING_STRING);
  });

  for (const c of ref.cases) {
    it(`matches the OCI Python SDK byte-for-byte: ${c.name}`, async () => {
      const signed = await signRequest(
        { method: c.method, url: c.url, headers: { date: c.date }, body: c.body ?? undefined },
        await creds(),
      );
      expect(signed.headers.get("authorization")).toBe(c.expected.authorization);
      if (c.expected["x-content-sha256"]) {
        expect(signed.headers.get("x-content-sha256")).toBe(c.expected["x-content-sha256"]);
        expect(signed.headers.get("content-length")).toBe(c.expected["content-length"]);
        expect(signed.headers.get("content-type")).toBe(c.expected["content-type"]);
        expect(signed.body?.byteLength).toBe(Number(c.expected["content-length"]));
      } else {
        expect(signed.headers.has("x-content-sha256")).toBe(false);
        expect(signed.body).toBeUndefined();
      }
    });
  }

  it("produces signatures that verify against the public key", async () => {
    const der = Uint8Array.from(
      atob(ref.publicKeyPem.replace(/-----[^-]+-----|\s+/g, "")),
      (ch) => ch.charCodeAt(0),
    );
    const pub = await crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signed = await signRequest({ method: "POST", url: "https://iaas.us-ashburn-1.oraclecloud.com/20160918/vcns", body: "{}" }, await creds());
    const sig = /signature="([^"]+)"/.exec(signed.headers.get("authorization")!)![1]!;
    const sigBytes = Uint8Array.from(atob(sig), (ch) => ch.charCodeAt(0));
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, sigBytes, new TextEncoder().encode(signed.signingString))).toBe(true);
  });

  it("defaults the date header to the supplied clock in IMF-fixdate form", async () => {
    // 2014-01-09 is a Thursday (the doc example string "Thu, 05 Jan 2014" has a wrong weekday; it is only ever used verbatim).
    const now = new Date(Date.UTC(2014, 0, 9, 21, 31, 40));
    expect(httpDate(now)).toBe("Thu, 09 Jan 2014 21:31:40 GMT");
    const signed = await signRequest({ method: "GET", url: "https://iaas.us-ashburn-1.oraclecloud.com/20160918/vcns" }, await creds(), now);
    expect(signed.headers.get("date")).toBe("Thu, 09 Jan 2014 21:31:40 GMT");
  });

  it("rejects a body on non-body methods and unknown methods", async () => {
    const c = await creds();
    await expect(signRequest({ method: "GET", url: "https://x.oraclecloud.com/a", body: "x" }, c)).rejects.toThrow(/must not have a body/);
    await expect(signRequest({ method: "OPTIONS", url: "https://x.oraclecloud.com/a" }, c)).rejects.toThrow(/Cannot sign/);
  });
});

describe("importPrivateKeyPem", () => {
  it("rejects PKCS#1 keys with an explicit message", async () => {
    await expect(importPrivateKeyPem(ORACLE_DOC_PKCS1_HEADER)).rejects.toThrow(/PKCS#8/);
  });

  it("rejects input without a PEM private key", async () => {
    await expect(importPrivateKeyPem("not a key")).rejects.toThrow(/No PKCS#8 private key/);
  });
});
