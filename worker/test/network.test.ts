import { describe, expect, it } from "vitest";
import { OciClient } from "../src/oci/client";
import { ensureNetwork, NAMES } from "../src/oci/network";
import { importPrivateKeyPem } from "../src/oci/signer";
import ref from "./fixtures/signer-reference.json";

const C = "ocid1.compartment.oc1..root";
type Obj = Record<string, any>;

/** Stateful in-memory stand-in for the OCI networking API (enough for ensureNetwork). */
class FakeOci {
  vcns = new Map<string, Obj>();
  igws = new Map<string, Obj>();
  routeTables = new Map<string, Obj>();
  securityLists = new Map<string, Obj>();
  subnets = new Map<string, Obj>();
  tokens = new Map<string, Obj>();
  calls: string[] = [];
  private n = 0;
  constructor(private readonly defaultSsh = false) {}

  private id(kind: string) {
    return `ocid1.${kind}.oc1..${++this.n}`;
  }

  private store(kind: string): Map<string, Obj> {
    return { vcns: this.vcns, internetGateways: this.igws, routeTables: this.routeTables, securityLists: this.securityLists, subnets: this.subnets }[kind]!;
  }

  handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const [, , kind, id] = url.pathname.split("/"); // /20160918/<kind>/<id?>
    this.calls.push(`${req.method} ${kind}${id ? "/:id" : ""}`);
    const store = this.store(kind!);
    const q = url.searchParams;
    if (req.method === "GET" && !id) {
      return Response.json(
        [...store.values()].filter(
          (r) => r.compartmentId === q.get("compartmentId") && (!q.get("vcnId") || r.vcnId === q.get("vcnId")) && (!q.get("displayName") || r.displayName === q.get("displayName")),
        ),
      );
    }
    if (req.method === "GET") {
      const r = store.get(id!);
      if (!r) return Response.json({ code: "NotAuthorizedOrNotFound", message: id }, { status: 404 });
      if (r.lifecycleState === "PROVISIONING") r.lifecycleState = "AVAILABLE";
      return Response.json(r);
    }
    if (req.method === "PUT") {
      const r = store.get(id!)!;
      Object.assign(r, await req.json());
      return Response.json(r);
    }
    if (req.method === "POST") {
      const token = req.headers.get("opc-retry-token");
      if (token && this.tokens.has(token)) return Response.json(this.tokens.get(token));
      const body = (await req.json()) as Obj;
      const r: Obj = { ...body, id: this.id(kind!), lifecycleState: "PROVISIONING" };
      if (kind === "vcns") {
        const rt = { id: this.id("routetable"), compartmentId: body.compartmentId, vcnId: r.id, routeRules: [] };
        const sl = {
          id: this.id("securitylist"),
          compartmentId: body.compartmentId,
          vcnId: r.id,
          ingressSecurityRules: this.defaultSsh
            ? [{ protocol: "6", source: "0.0.0.0/0", tcpOptions: { destinationPortRange: { min: 22, max: 22 } } }]
            : [{ protocol: "1", source: "0.0.0.0/0" }],
        };
        this.routeTables.set(rt.id, rt);
        this.securityLists.set(sl.id, sl);
        Object.assign(r, { defaultRouteTableId: rt.id, defaultSecurityListId: sl.id });
      }
      store.set(r.id, r);
      if (token) this.tokens.set(token, r);
      return Response.json(r);
    }
    return new Response("unsupported", { status: 500 });
  };
}

async function client(fake: FakeOci) {
  const privateKey = await importPrivateKeyPem(ref.privateKeyPem);
  return new OciClient({ tenancyOcid: "t", userOcid: "u", fingerprint: ref.fingerprint, privateKey }, fake.handle);
}

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
