/**
 * Live, READ-ONLY calls against a real tenancy. Skipped unless the cloud
 * environment defines OCI_TEST_KEY_B64 (base64 of a PKCS#8 PEM), OCI_TEST_USER,
 * OCI_TEST_TENANCY and OCI_TEST_REGION. Never add mutating calls here.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { OciClient } from "../src/oci/client";
import { discover } from "../src/oci/discovery";
import { homeRegion, listAvailabilityDomains } from "../src/oci/identity";
import { base64Decode, fingerprintFromSpki, pemDecode } from "../src/oci/keys";
import { importPrivateKeyPem } from "../src/oci/signer";
import { planLayout } from "../src/plan";

const configured = Boolean(env.OCI_TEST_KEY_B64 && env.OCI_TEST_USER && env.OCI_TEST_TENANCY && env.OCI_TEST_REGION);

async function liveClient() {
  const pem = new TextDecoder().decode(base64Decode(env.OCI_TEST_KEY_B64!.trim()));
  // Fingerprint = MD5 of the DER public key; derive the public key from the private key's JWK (n, e).
  const extractable = await crypto.subtle.importKey(
    "pkcs8", pemDecode(pem, "PRIVATE KEY"), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign"],
  );
  const { n, e } = (await crypto.subtle.exportKey("jwk", extractable)) as JsonWebKey;
  const pub = await crypto.subtle.importKey(
    "jwk", { kty: "RSA", n, e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["verify"],
  );
  const fingerprint = await fingerprintFromSpki(new Uint8Array((await crypto.subtle.exportKey("spki", pub)) as ArrayBuffer));
  return new OciClient(
    { tenancyOcid: env.OCI_TEST_TENANCY!, userOcid: env.OCI_TEST_USER!, fingerprint, privateKey: await importPrivateKeyPem(pem) },
    // Safety guard: this suite must never change anything in the tenancy.
    (req) => (req.method === "GET" ? fetch(req) : Promise.reject(new Error(`live tests are read-only; refused ${req.method}`))),
  );
}

describe.skipIf(!configured)("live OCI (read-only)", () => {
  it("resolves the home region and lists its availability domains", async () => {
    const client = await liveClient();
    const home = await homeRegion(client, env.OCI_TEST_REGION!, env.OCI_TEST_TENANCY!);
    expect(home).toMatch(/^[a-z]+(?:-[a-z]+)+-\d+$/);
    const ads = await listAvailabilityDomains(client, home, env.OCI_TEST_TENANCY!);
    expect(ads.length).toBeGreaterThan(0);
    console.log(`live: home region ${home}; ${ads.length} availability domain(s)`);
  }, 30_000);

  it("discovers the tenancy and produces a dry-run layout plan", async () => {
    const client = await liveClient();
    const home = await homeRegion(client, env.OCI_TEST_REGION!, env.OCI_TEST_TENANCY!);
    const ads = (await listAvailabilityDomains(client, home, env.OCI_TEST_TENANCY!)).map((a) => a.name);
    const d = await discover(client, home, env.OCI_TEST_TENANCY!, ads);
    const plan = planLayout(d);
    console.log(
      "live discovery:",
      JSON.stringify({
        instances: d.instances.map((i) => `${i.shape} ${i.ocpus}/${i.memoryInGBs} ${i.lifecycleState}`),
        storageUsedGB: d.storageUsedGB,
        vcnCount: d.vcnCount,
        publicNetworks: d.networks.filter((n) => n.publicSubnets.length).length,
        limits: d.limits.map((l) => `${l.name} ${l.scopeType} ${l.availabilityDomain ?? "-"} = ${l.value}`),
        images: { a1: d.images.a1?.displayName, micro: d.images.micro?.displayName },
      }, null, 2),
    );
    console.log("live plan:", JSON.stringify({ create: plan.create.map((c) => [c.role, c.bootVolumeGB, c.candidateAds]), network: plan.network, blockers: plan.blockers, notes: plan.notes }, null, 2));
    expect(d.storageUsedGB).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
