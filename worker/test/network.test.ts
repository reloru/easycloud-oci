import { describe, expect, it } from "vitest";
import { OciClient } from "../src/oci/client";
import { ensureNetwork, NAMES } from "../src/oci/network";
import { importPrivateKeyPem } from "../src/oci/signer";
import ref from "./fixtures/signer-reference.json";
import { FakeOci, fakeClient as client, type Obj } from "./helpers/fake-oci";

const C = "ocid1.compartment.oc1..root";

const opts = { region: "us-ashburn-1", compartmentId: C, retrySeed: "easycloud-acct", sleep: async () => {} };
const mutations = (calls: string[]) => calls.filter((c) => !c.startsWith("GET"));

describe("ensureNetwork", () => {
  it("builds VCN, gateway, default route, SSH rule and public subnet in an empty compartment", async () => {
    const fake = new FakeOci();
    const result = await ensureNetwork(await client(fake), opts);
    expect(result.changes).toEqual([
      "created network",
      "created internet gateway",
      "routed internet traffic through the gateway",
      "allowed SSH",
      "created public subnet",
    ]);
    const vcn = fake.vcns.get(result.vcnId)!;
    expect(vcn).toMatchObject({ displayName: NAMES.vcn, cidrBlocks: ["10.0.0.0/16"], freeformTags: { easycloud: "managed" }, lifecycleState: "AVAILABLE" });
    const igw = [...fake.igws.values()][0]!;
    expect(fake.routeTables.get(vcn.defaultRouteTableId)!.routeRules).toEqual([
      { destination: "0.0.0.0/0", destinationType: "CIDR_BLOCK", networkEntityId: igw.id, description: "Internet access (easycloud)" },
    ]);
    expect(fake.securityLists.get(vcn.defaultSecurityListId)!.ingressSecurityRules).toContainEqual(
      expect.objectContaining({ protocol: "6", source: "0.0.0.0/0", tcpOptions: { destinationPortRange: { min: 22, max: 22 } } }),
    );
    expect(fake.subnets.get(result.subnetId)).toMatchObject({
      vcnId: vcn.id, cidrBlock: "10.0.0.0/24", prohibitPublicIpOnVnic: false, routeTableId: vcn.defaultRouteTableId, securityListIds: [vcn.defaultSecurityListId],
    });
  });

  it("is idempotent: a second run changes nothing and makes no writes", async () => {
    const fake = new FakeOci();
    const first = await ensureNetwork(await client(fake), opts);
    fake.calls = [];
    const second = await ensureNetwork(await client(fake), opts);
    expect(second).toEqual({ vcnId: first.vcnId, subnetId: first.subnetId, changes: [] });
    expect(mutations(fake.calls)).toEqual([]);
  });

  it("repairs a half-built network without recreating what exists", async () => {
    const fake = new FakeOci(true);
    const c = await client(fake);
    const full = await ensureNetwork(c, opts);
    fake.subnets.clear();
    fake.igws.clear();
    fake.calls = [];
    const repaired = await ensureNetwork(c, { ...opts, retrySeed: "easycloud-acct-run2" });
    expect(repaired.vcnId).toBe(full.vcnId);
    expect(repaired.changes).toEqual(["created internet gateway", "routed internet traffic through the gateway", "created public subnet"]);
    expect(mutations(fake.calls)).toEqual(["POST internetGateways", "PUT routeTables/:id", "POST subnets"]);
  });

  it("sends a stable opc-retry-token on every create", async () => {
    const tokens: string[] = [];
    const fake = new FakeOci();
    const privateKey = await importPrivateKeyPem(ref.privateKeyPem);
    const c = new OciClient({ tenancyOcid: "t", userOcid: "u", fingerprint: ref.fingerprint, privateKey }, async (req) => {
      if (req.method === "POST") tokens.push(req.headers.get("opc-retry-token") ?? "missing");
      return fake.handle(req);
    });
    await ensureNetwork(c, opts);
    expect(tokens).toEqual(["easycloud-acct-vcn", "easycloud-acct-igw", "easycloud-acct-subnet"]);
  });

  it("re-enables a disabled internet gateway instead of creating a second one", async () => {
    const fake = new FakeOci(true);
    const c = await client(fake);
    await ensureNetwork(c, opts);
    const igw = [...fake.igws.values()][0]!;
    igw.isEnabled = false;
    fake.calls = [];
    const result = await ensureNetwork(c, { ...opts, retrySeed: "easycloud-acct-run2" });
    expect(result.changes).toEqual(["enabled internet gateway"]);
    expect(mutations(fake.calls)).toEqual(["PUT internetGateways/:id"]);
    expect(fake.igws.size).toBe(1);
    expect(igw.isEnabled).toBe(true);
  });

  it("gives up when a resource never becomes AVAILABLE", async () => {
    const fake = new FakeOci();
    const stuck = async (req: Request) => {
      const res = await fake.handle(req);
      if (req.method !== "GET" || !new URL(req.url).pathname.match(/\/vcns\/./)) return res;
      return Response.json({ ...(await res.json() as Obj), lifecycleState: "PROVISIONING" });
    };
    const privateKey = await importPrivateKeyPem(ref.privateKeyPem);
    const c = new OciClient({ tenancyOcid: "t", userOcid: "u", fingerprint: ref.fingerprint, privateKey }, stuck);
    await expect(ensureNetwork(c, { ...opts, pollAttempts: 3 })).rejects.toThrow(/did not become AVAILABLE/);
  });
});
