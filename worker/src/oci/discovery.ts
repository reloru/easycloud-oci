/**
 * Read-only discovery of everything the layout planner needs, in the home
 * region: compartments, instances, boot/block volumes, VCNs (with public
 * subnets that route to an enabled internet gateway), compute limit values,
 * and the newest Ubuntu Minimal image per target shape.
 * Paths and fields follow Oracle's API (core 20160918, identity 20160918, limits 20190729).
 */
import type { OciClient } from "./client";
import { ociEndpoint, ociUrl } from "./url";

export const SHAPES = { a1: "VM.Standard.A1.Flex", micro: "VM.Standard.E2.1.Micro" } as const;
export const LIMIT_NAMES = ["standard-a1-core-count", "standard-a1-memory-count", "standard-e2-micro-core-count"] as const;

export interface InstanceSummary {
  id: string;
  displayName: string;
  shape: string;
  ocpus: number;
  memoryInGBs: number;
  lifecycleState: string;
  availabilityDomain: string;
}

export interface NetworkSummary {
  vcnId: string;
  displayName: string;
  compartmentId: string;
  /** Subnets that allow public IPs and route 0.0.0.0/0 to an enabled internet gateway. */
  publicSubnets: { id: string; cidrBlock: string; availabilityDomain: string | null }[];
}

export interface ImageSummary {
  id: string;
  displayName: string;
  operatingSystemVersion: string;
}

export interface LimitValue {
  name: string;
  scopeType: string;
  availabilityDomain?: string | null;
  value: number;
}

export interface Discovery {
  region: string;
  tenancy: string;
  availabilityDomains: string[];
  compartmentIds: string[];
  instances: InstanceSummary[];
  /** Sum of boot + block volume sizes that still exist (not TERMINATED). */
  storageUsedGB: number;
  networks: NetworkSummary[];
  vcnCount: number;
  limits: LimitValue[];
  images: { a1?: ImageSummary; micro?: ImageSummary };
}

interface RawInstance {
  id: string;
  displayName: string;
  shape: string;
  shapeConfig?: { ocpus?: number; memoryInGBs?: number };
  lifecycleState: string;
  availabilityDomain: string;
}
interface RawVolume { sizeInGBs: number; lifecycleState: string }
interface RawVcn { id: string; displayName: string; compartmentId: string; lifecycleState: string }
interface RawSubnet {
  id: string;
  vcnId: string;
  cidrBlock: string;
  prohibitPublicIpOnVnic: boolean;
  routeTableId: string;
  availabilityDomain?: string | null;
  lifecycleState: string;
}
interface RawRouteTable { id: string; routeRules: { destination?: string; networkEntityId: string }[] }
interface RawInternetGateway { id: string; isEnabled?: boolean; lifecycleState: string }
interface RawImage { id: string; displayName: string; operatingSystemVersion: string }

const GONE = new Set(["TERMINATING", "TERMINATED"]);
const UBUNTU_MINIMAL = /^24\.04 Minimal\b/;

async function compartmentIds(client: OciClient, region: string, tenancy: string): Promise<string[]> {
  const subtree = await client.listAll<{ id: string; lifecycleState: string }>(
    ociUrl(ociEndpoint("identity", region), ["20160918", "compartments"], {
      compartmentId: tenancy,
      compartmentIdInSubtree: true,
      accessLevel: "ANY",
    }),
  );
  return [tenancy, ...subtree.filter((c) => c.lifecycleState === "ACTIVE").map((c) => c.id)];
}

async function networksIn(client: OciClient, region: string, vcn: RawVcn): Promise<NetworkSummary> {
  const iaas = ociEndpoint("iaas", region);
  const q = { compartmentId: vcn.compartmentId, vcnId: vcn.id };
  const [subnets, routeTables, gateways] = await Promise.all([
    client.listAll<RawSubnet>(ociUrl(iaas, ["20160918", "subnets"], q)),
    client.listAll<RawRouteTable>(ociUrl(iaas, ["20160918", "routeTables"], q)),
    client.listAll<RawInternetGateway>(ociUrl(iaas, ["20160918", "internetGateways"], q)),
  ]);
  const igws = new Set(gateways.filter((g) => g.isEnabled !== false && !GONE.has(g.lifecycleState)).map((g) => g.id));
  const internetRouted = new Set(
    routeTables
      .filter((rt) => rt.routeRules.some((r) => r.destination === "0.0.0.0/0" && igws.has(r.networkEntityId)))
      .map((rt) => rt.id),
  );
  return {
    vcnId: vcn.id,
    displayName: vcn.displayName,
    compartmentId: vcn.compartmentId,
    publicSubnets: subnets
      .filter((s) => !GONE.has(s.lifecycleState) && !s.prohibitPublicIpOnVnic && internetRouted.has(s.routeTableId))
      .map((s) => ({ id: s.id, cidrBlock: s.cidrBlock, availabilityDomain: s.availabilityDomain ?? null })),
  };
}

async function newestImage(client: OciClient, region: string, tenancy: string, shape: string): Promise<ImageSummary | undefined> {
  const images = await client.request<RawImage[]>(
    "GET",
    ociUrl(ociEndpoint("iaas", region), ["20160918", "images"], {
      compartmentId: tenancy,
      operatingSystem: "Canonical Ubuntu",
      shape,
      lifecycleState: "AVAILABLE",
      sortBy: "TIMECREATED",
      sortOrder: "DESC",
    }),
  );
  const match = images.find((i) => UBUNTU_MINIMAL.test(i.operatingSystemVersion));
  return match && { id: match.id, displayName: match.displayName, operatingSystemVersion: match.operatingSystemVersion };
}

async function computeLimits(client: OciClient, region: string, tenancy: string): Promise<LimitValue[]> {
  const all = await Promise.all(
    LIMIT_NAMES.map((name) =>
      client
        .listAll<LimitValue>(
          ociUrl(ociEndpoint("limits", region), ["20190729", "limitValues"], { compartmentId: tenancy, serviceName: "compute", name }),
        )
        .catch(() => [] as LimitValue[]),
    ),
  );
  return all.flat();
}

export async function discover(
  client: OciClient,
  region: string,
  tenancy: string,
  availabilityDomains: string[],
): Promise<Discovery> {
  const iaas = ociEndpoint("iaas", region);
  const compartments = await compartmentIds(client, region, tenancy);

  const perCompartment = await Promise.all(
    compartments.map(async (compartmentId) => {
      const [instances, bootVolumes, volumes, vcns] = await Promise.all([
        client.listAll<RawInstance>(ociUrl(iaas, ["20160918", "instances"], { compartmentId })),
        Promise.all(
          availabilityDomains.map((availabilityDomain) =>
            client.listAll<RawVolume>(ociUrl(iaas, ["20160918", "bootVolumes"], { availabilityDomain, compartmentId })),
          ),
        ).then((lists) => lists.flat()),
        client.listAll<RawVolume>(ociUrl(iaas, ["20160918", "volumes"], { compartmentId })),
        client.listAll<RawVcn>(ociUrl(iaas, ["20160918", "vcns"], { compartmentId })),
      ]);
      return { instances, bootVolumes, volumes, vcns };
    }),
  );

  const instances = perCompartment
    .flatMap((c) => c.instances)
    .filter((i) => !GONE.has(i.lifecycleState))
    .map<InstanceSummary>((i) => ({
      id: i.id,
      displayName: i.displayName,
      shape: i.shape,
      ocpus: i.shapeConfig?.ocpus ?? 0,
      memoryInGBs: i.shapeConfig?.memoryInGBs ?? 0,
      lifecycleState: i.lifecycleState,
      availabilityDomain: i.availabilityDomain,
    }));
  const storageUsedGB = perCompartment
    .flatMap((c) => [...c.bootVolumes, ...c.volumes])
    .filter((v) => !GONE.has(v.lifecycleState))
    .reduce((sum, v) => sum + v.sizeInGBs, 0);
  const vcns = perCompartment.flatMap((c) => c.vcns).filter((v) => !GONE.has(v.lifecycleState));

  const [networks, limits, a1, micro] = await Promise.all([
    Promise.all(vcns.map((v) => networksIn(client, region, v))),
    computeLimits(client, region, tenancy),
    newestImage(client, region, tenancy, SHAPES.a1),
    newestImage(client, region, tenancy, SHAPES.micro),
  ]);

  return {
    region,
    tenancy,
    availabilityDomains,
    compartmentIds: compartments,
    instances,
    storageUsedGB,
    networks,
    vcnCount: vcns.length,
    limits,
    images: { a1, micro },
  };
}
