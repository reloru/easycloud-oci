import { describe, expect, it } from "vitest";
import { OciClient } from "../src/oci/client";
import { discover, SHAPES } from "../src/oci/discovery";
import { importPrivateKeyPem } from "../src/oci/signer";
import ref from "./fixtures/signer-reference.json";

const T = "ocid1.tenancy.oc1..aaaatenancy";
const SUB = "ocid1.compartment.oc1..aaaasub";
const ADS = ["AD-1", "AD-2"];

type Route = (url: URL) => unknown;

async function clientWith(routes: Record<string, Route>, seen: string[] = []) {
  const privateKey = await importPrivateKeyPem(ref.privateKeyPem);
  return new OciClient({ tenancyOcid: T, userOcid: "u", fingerprint: ref.fingerprint, privateKey }, async (req) => {
    const url = new URL(req.url);
    seen.push(`${url.host}${url.pathname}${url.search}`);
    expect(req.headers.get("authorization")).toMatch(/^Signature /);
    const route = routes[`${url.host}${url.pathname}`];
    if (!route) return Response.json({ code: "NotFound", message: url.pathname }, { status: 404 });
    const body = route(url);
    if (body instanceof Response) return body;
    if (body && typeof body === "object" && !Array.isArray(body) && "items" in body) {
      const { items, next } = body as { items: unknown; next?: string };
      return Response.json(items, { headers: next ? { "opc-next-page": next } : {} });
    }
    return Response.json(body);
  });
}

const iaas = "iaas.us-ashburn-1.oraclecloud.com/20160918";

function routes(over: Record<string, Route> = {}): Record<string, Route> {
  return {
    "identity.us-ashburn-1.oci.oraclecloud.com/20160918/compartments": () => [
      { id: SUB, lifecycleState: "ACTIVE" },
      { id: "ocid1.compartment.oc1..deleted", lifecycleState: "DELETED" },
    ],
    [`${iaas}/instances`]: (u) =>
      u.searchParams.get("compartmentId") === T
        ? u.searchParams.get("page") === "p2"
          ? { items: [{ id: "i2", displayName: "micro", shape: SHAPES.micro, shapeConfig: { ocpus: 1, memoryInGBs: 1 }, lifecycleState: "STOPPED", availabilityDomain: "AD-2" }] }
          : { items: [
              { id: "i1", displayName: "a1", shape: SHAPES.a1, shapeConfig: { ocpus: 2, memoryInGBs: 12 }, lifecycleState: "RUNNING", availabilityDomain: "AD-1" },
              { id: "i0", displayName: "old", shape: SHAPES.a1, shapeConfig: { ocpus: 2, memoryInGBs: 12 }, lifecycleState: "TERMINATED", availabilityDomain: "AD-1" },
            ], next: "p2" }
        : [],
    [`${iaas}/bootVolumes`]: (u) =>
      u.searchParams.get("compartmentId") === T && u.searchParams.get("availabilityDomain") === "AD-1"
        ? [{ sizeInGBs: 106, lifecycleState: "AVAILABLE" }, { sizeInGBs: 50, lifecycleState: "TERMINATED" }]
        : u.searchParams.get("compartmentId") === T
          ? [{ sizeInGBs: 47, lifecycleState: "AVAILABLE" }]
          : [],
    [`${iaas}/volumes`]: (u) => (u.searchParams.get("compartmentId") === SUB ? [{ sizeInGBs: 20, lifecycleState: "AVAILABLE" }] : []),
    [`${iaas}/vcns`]: (u) =>
      u.searchParams.get("compartmentId") === T
        ? [
            { id: "vcn-pub", displayName: "public", compartmentId: T, lifecycleState: "AVAILABLE" },
            { id: "vcn-priv", displayName: "private", compartmentId: T, lifecycleState: "AVAILABLE" },
          ]
        : [],
    [`${iaas}/subnets`]: (u) =>
      u.searchParams.get("vcnId") === "vcn-pub"
        ? [
            { id: "s-pub", vcnId: "vcn-pub", cidrBlock: "10.0.0.0/24", prohibitPublicIpOnVnic: false, routeTableId: "rt-igw", availabilityDomain: null, lifecycleState: "AVAILABLE" },
            { id: "s-priv", vcnId: "vcn-pub", cidrBlock: "10.0.1.0/24", prohibitPublicIpOnVnic: true, routeTableId: "rt-igw", lifecycleState: "AVAILABLE" },
            { id: "s-noroute", vcnId: "vcn-pub", cidrBlock: "10.0.2.0/24", prohibitPublicIpOnVnic: false, routeTableId: "rt-none", lifecycleState: "AVAILABLE" },
          ]
        : [{ id: "s-x", vcnId: "vcn-priv", cidrBlock: "10.1.0.0/24", prohibitPublicIpOnVnic: false, routeTableId: "rt-disabled", lifecycleState: "AVAILABLE" }],
    [`${iaas}/routeTables`]: (u) =>
      u.searchParams.get("vcnId") === "vcn-pub"
        ? [{ id: "rt-igw", routeRules: [{ destination: "0.0.0.0/0", networkEntityId: "igw-1" }] }, { id: "rt-none", routeRules: [] }]
        : [{ id: "rt-disabled", routeRules: [{ destination: "0.0.0.0/0", networkEntityId: "igw-off" }] }],
    [`${iaas}/internetGateways`]: (u) =>
      u.searchParams.get("vcnId") === "vcn-pub"
        ? [{ id: "igw-1", isEnabled: true, lifecycleState: "AVAILABLE" }]
        : [{ id: "igw-off", isEnabled: false, lifecycleState: "AVAILABLE" }],
    [`${iaas}/images`]: (u) =>
      u.searchParams.get("shape") === SHAPES.a1
        ? [
            { id: "img-full", displayName: "Canonical-Ubuntu-24.04-aarch64", operatingSystemVersion: "24.04 aarch64" },
            { id: "img-a1", displayName: "Canonical-Ubuntu-24.04-Minimal-aarch64", operatingSystemVersion: "24.04 Minimal aarch64" },
          ]
        : [{ id: "img-old", displayName: "Canonical-Ubuntu-22.04-Minimal", operatingSystemVersion: "22.04 Minimal" }],
    "limits.us-ashburn-1.oci.oraclecloud.com/20190729/limitValues": (u) =>
      u.searchParams.get("name") === "standard-e2-micro-core-count"
        ? [{ name: "standard-e2-micro-core-count", scopeType: "AD", availabilityDomain: "AD-2", value: 2 }]
        : Response.json({ code: "InternalError", message: "boom" }, { status: 500 }),
    ...over,
  };
}

describe("discover", () => {
  it("summarises instances, storage, networks, limits and images in the home region", async () => {
    const seen: string[] = [];
    const d = await discover(await clientWith(routes(), seen), "us-ashburn-1", T, ADS);

    expect(d.compartmentIds).toEqual([T, SUB]);
    expect(d.instances.map((i) => [i.id, i.shape, i.ocpus, i.memoryInGBs, i.lifecycleState])).toEqual([
      ["i1", SHAPES.a1, 2, 12, "RUNNING"],
      ["i2", SHAPES.micro, 1, 1, "STOPPED"],
    ]);
    expect(d.storageUsedGB).toBe(106 + 47 + 20); // root: AD-1 boot 106 (+50 terminated, excluded), AD-2 boot 47; sub-compartment: block 20
    expect(d.vcnCount).toBe(2);
    expect(d.networks).toEqual([
      { vcnId: "vcn-pub", displayName: "public", compartmentId: T, publicSubnets: [{ id: "s-pub", cidrBlock: "10.0.0.0/24", availabilityDomain: null }] },
      { vcnId: "vcn-priv", displayName: "private", compartmentId: T, publicSubnets: [] },
    ]);
    expect(d.limits).toEqual([{ name: "standard-e2-micro-core-count", scopeType: "AD", availabilityDomain: "AD-2", value: 2 }]);
    expect(d.images.a1?.id).toBe("img-a1");
    expect(d.images.micro).toBeUndefined();

    expect(seen).toContain(`${iaas}/instances?compartmentId=${encodeURIComponent(T)}&page=p2`);
    expect(seen).toContain(
      `${iaas}/images?compartmentId=${encodeURIComponent(T)}&operatingSystem=Canonical%20Ubuntu&shape=VM.Standard.A1.Flex&lifecycleState=AVAILABLE&sortBy=TIMECREATED&sortOrder=DESC`,
    );
    expect(seen.filter((s) => s.includes("/bootVolumes"))).toHaveLength(ADS.length * 2);
  });
});
