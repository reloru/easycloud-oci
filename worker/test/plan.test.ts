import { describe, expect, it } from "vitest";
import { SHAPES, type Discovery, type InstanceSummary } from "../src/oci/discovery";
import { planLayout } from "../src/plan";

const ADS = ["Uocm:US-ASHBURN-AD-1", "Uocm:US-ASHBURN-AD-2", "Uocm:US-ASHBURN-AD-3"];
const IMAGES = {
  a1: { id: "img-a1", displayName: "Canonical-Ubuntu-24.04-Minimal-aarch64", operatingSystemVersion: "24.04 Minimal aarch64" },
  micro: { id: "img-micro", displayName: "Canonical-Ubuntu-24.04-Minimal", operatingSystemVersion: "24.04 Minimal" },
};

function inst(shape: string, ocpus: number, memoryInGBs: number): InstanceSummary {
  return { id: `i-${shape}-${ocpus}`, displayName: shape, shape, ocpus, memoryInGBs, lifecycleState: "RUNNING", availabilityDomain: ADS[0]! };
}

function discovery(over: Partial<Discovery> = {}): Discovery {
  return {
    region: "us-ashburn-1",
    tenancy: "t",
    availabilityDomains: ADS,
    compartmentIds: ["t"],
    instances: [],
    storageUsedGB: 0,
    networks: [],
    vcnCount: 0,
    limits: [],
    images: IMAGES,
    ...over,
  };
}

const PUBLIC_NET = { vcnId: "vcn-1", displayName: "main", compartmentId: "t", publicSubnets: [{ id: "sub-1", cidrBlock: "10.0.0.0/24", availabilityDomain: null }] };

describe("planLayout", () => {
  it("fresh account: A1 2/12 with 106 GB, two micros at 47 GB, new network", () => {
    const plan = planLayout(discovery({
      limits: ADS.map((ad, i) => ({ name: "standard-e2-micro-core-count", scopeType: "AD", availabilityDomain: ad, value: i === 1 ? 2 : 0 })),
    }));
    expect(plan.blockers).toEqual([]);
    expect(plan.network).toEqual({ action: "create" });
    expect(plan.create).toEqual([
      { role: "a1", shape: SHAPES.a1, ocpus: 2, memoryInGBs: 12, bootVolumeGB: 106, image: IMAGES.a1, candidateAds: ADS },
      { role: "micro", shape: SHAPES.micro, bootVolumeGB: 47, image: IMAGES.micro, candidateAds: [ADS[1]] },
      { role: "micro", shape: SHAPES.micro, bootVolumeGB: 47, image: IMAGES.micro, candidateAds: [ADS[1]] },
    ]);
    expect(plan.storage).toEqual({ allowanceGB: 200, usedGB: 0, freeGB: 200 });
  });

  it("reference layout already present: nothing to create", () => {
    const plan = planLayout(discovery({
      instances: [inst(SHAPES.a1, 2, 12), inst(SHAPES.micro, 1, 1), inst(SHAPES.micro, 1, 1)],
      storageUsedGB: 200,
      networks: [PUBLIC_NET, { ...PUBLIC_NET, vcnId: "vcn-2", publicSubnets: [] }],
      vcnCount: 2,
    }));
    expect(plan.create).toEqual([]);
    expect(plan.network).toEqual({ action: "none" });
    expect(plan.blockers).toEqual([]);
    expect(plan.notes).toEqual(["Nothing to create: the free servers already exist."]);
  });

  it("A1 exists: adds both micros into the remaining 94 GB and reuses the network", () => {
    const plan = planLayout(discovery({ instances: [inst(SHAPES.a1, 2, 12)], storageUsedGB: 106, networks: [PUBLIC_NET], vcnCount: 1 }));
    expect(plan.create.map((c) => [c.role, c.bootVolumeGB])).toEqual([["micro", 47], ["micro", 47]]);
    expect(plan.network).toEqual({ action: "reuse", vcnId: "vcn-1", subnetId: "sub-1", displayName: "main" });
  });

  it("partial A1 allowance left: sizes the new A1 to what remains", () => {
    const plan = planLayout(discovery({ instances: [inst(SHAPES.a1, 1, 6)], storageUsedGB: 50 }));
    expect(plan.create[0]).toMatchObject({ role: "a1", ocpus: 1, memoryInGBs: 6, bootVolumeGB: 150 - 47 * 2 });
  });

  it("limited storage: A1 takes priority and micros that don't fit are reported", () => {
    const plan = planLayout(discovery({ storageUsedGB: 120 }));
    expect(plan.create.map((c) => [c.role, c.bootVolumeGB])).toEqual([["a1", 80]]);
    expect(plan.notes).toEqual(["Only 0 of 2 small (AMD) servers fit in the remaining storage."]);
  });

  it("blocks when storage is below the minimum boot volume", () => {
    const plan = planLayout(discovery({ storageUsedGB: 160 }));
    expect(plan.create).toEqual([]);
    expect(plan.blockers).toEqual(["Not enough free storage for a server: 40 GB free, 47 GB needed."]);
  });

  it("blocks when both free networks exist and neither reaches the internet", () => {
    const plan = planLayout(discovery({
      networks: [{ ...PUBLIC_NET, publicSubnets: [] }, { ...PUBLIC_NET, vcnId: "vcn-2", publicSubnets: [] }],
      vcnCount: 2,
    }));
    expect(plan.network.action).toBe("blocked");
    expect(plan.blockers).toHaveLength(1);
  });

  it("blocks when no Ubuntu Minimal image exists for a planned shape", () => {
    const plan = planLayout(discovery({ images: { micro: IMAGES.micro } }));
    expect(plan.blockers).toEqual(["No Ubuntu 24.04 Minimal image found for the Ampere server."]);
  });

  it("falls back to all ADs when limit values are absent or all zero", () => {
    const plan = planLayout(discovery({
      limits: ADS.map((ad) => ({ name: "standard-e2-micro-core-count", scopeType: "AD", availabilityDomain: ad, value: 0 })),
    }));
    expect(plan.create.find((c) => c.role === "micro")?.candidateAds).toEqual(ADS);
  });

  it("falls back to the 47 GB image default when the A1 remainder would be an invalid custom size", () => {
    // 96 GB free, one micro wanted: 96 - 47 = 49 GB is below OCI's 50 GB custom minimum.
    const plan = planLayout(discovery({ storageUsedGB: 104 }), undefined, { a1: true, micros: 1 });
    expect(plan.create.map((c) => [c.role, c.bootVolumeGB])).toEqual([["a1", 47], ["micro", 47]]);
  });

  it("prefers a regional subnet over an AD-specific one", () => {
    const adOnly = { vcnId: "vcn-ad", displayName: "ad", compartmentId: "t", publicSubnets: [{ id: "sub-ad", cidrBlock: "10.1.0.0/24", availabilityDomain: ADS[0]! }] };
    const plan = planLayout(discovery({ networks: [adOnly, PUBLIC_NET], vcnCount: 2 }));
    expect(plan.network).toEqual({ action: "reuse", vcnId: "vcn-1", subnetId: "sub-1", displayName: "main" });
    expect(plan.create.find((c) => c.role === "a1")!.candidateAds).toEqual(ADS);
  });

  it("reuses an AD-specific subnet only when every server can launch there, and pins them to that AD", () => {
    const microLimits = ADS.map((ad, i) => ({ name: "standard-e2-micro-core-count", scopeType: "AD", availabilityDomain: ad, value: i === 1 ? 2 : 0 }));
    const inAd2 = { vcnId: "vcn-ad2", displayName: "ad2", compartmentId: "t", publicSubnets: [{ id: "sub-ad2", cidrBlock: "10.2.0.0/24", availabilityDomain: ADS[1]! }] };
    const plan = planLayout(discovery({ networks: [inAd2], vcnCount: 1, limits: microLimits }));
    expect(plan.network).toEqual({ action: "reuse", vcnId: "vcn-ad2", subnetId: "sub-ad2", displayName: "ad2" });
    expect(plan.create.map((c) => c.candidateAds)).toEqual([[ADS[1]], [ADS[1]], [ADS[1]]]);
  });

  it("does not reuse an AD-specific subnet the micros cannot use: creates a network, or blocks at the VCN limit", () => {
    const microLimits = ADS.map((ad, i) => ({ name: "standard-e2-micro-core-count", scopeType: "AD", availabilityDomain: ad, value: i === 1 ? 2 : 0 }));
    const inAd1 = { vcnId: "vcn-ad1", displayName: "ad1", compartmentId: "t", publicSubnets: [{ id: "sub-ad1", cidrBlock: "10.3.0.0/24", availabilityDomain: ADS[0]! }] };
    expect(planLayout(discovery({ networks: [inAd1], vcnCount: 1, limits: microLimits })).network).toEqual({ action: "create" });
    const blocked = planLayout(discovery({ networks: [inAd1, { ...inAd1, vcnId: "vcn-x", publicSubnets: [] }], vcnCount: 2, limits: microLimits }));
    expect(blocked.network.action).toBe("blocked");
    expect(blocked.blockers[0]).toMatch(/different availability domain/);
  });

  it("respects a request for fewer servers", () => {
    const plan = planLayout(discovery(), undefined, { a1: true, micros: 0 });
    expect(plan.create.map((c) => [c.role, c.bootVolumeGB])).toEqual([["a1", 200]]);
  });
});
