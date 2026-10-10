/**
 * M4: create or repair the app's network, idempotently. Every step first
 * looks for an existing easycloud resource and only creates what is missing,
 * so re-running after a partial failure finishes the job without duplicates.
 * Creates carry an opc-retry-token so a retried POST cannot double-create.
 * Shapes follow Oracle's core API (20160918) as modelled in its SDKs.
 */
import type { OciClient } from "./client";
import { ociEndpoint, ociUrl } from "./url";

export const NAMES = { vcn: "easycloud-vcn", igw: "easycloud-igw", subnet: "easycloud-public" } as const;
const TAGS = { easycloud: "managed" };
const VCN_CIDR = "10.0.0.0/16";
const SUBNET_CIDR = "10.0.0.0/24";
const ANYWHERE = "0.0.0.0/0";

interface Vcn { id: string; lifecycleState: string; defaultRouteTableId: string; defaultSecurityListId: string }
interface Gateway { id: string; isEnabled?: boolean; lifecycleState: string }
interface RouteRule { destination?: string; destinationType?: string; networkEntityId: string; description?: string }
interface RouteTable { id: string; routeRules: RouteRule[] }
interface IngressRule {
  protocol: string;
  source: string;
  sourceType?: string;
  isStateless?: boolean;
  tcpOptions?: { destinationPortRange?: { min: number; max: number } };
  udpOptions?: { destinationPortRange?: { min: number; max: number } };
  description?: string;
}
interface SecurityList { id: string; ingressSecurityRules: IngressRule[] }
interface Subnet { id: string; lifecycleState: string }

const LIVE = (r: { lifecycleState: string }) => r.lifecycleState !== "TERMINATED" && r.lifecycleState !== "TERMINATING";

export interface NetworkOptions {
  region: string;
  compartmentId: string;
  /**
   * Seeds opc-retry-token values. Must be unique per run (e.g. account id + run id): OCI keeps a
   * token for 24 h and may answer a reused token with the original (possibly deleted) resource.
   * Re-runs are already idempotent through the lookups below.
   */
  retrySeed: string;
  sleep?: (ms: number) => Promise<void>;
  pollAttempts?: number;
  pollDelayMs?: number;
}

export interface NetworkResult {
  vcnId: string;
  subnetId: string;
  /** What this call changed, in order (empty when everything already existed). */
  changes: string[];
}

export async function ensureNetwork(client: OciClient, opts: NetworkOptions): Promise<NetworkResult> {
  const iaas = ociEndpoint("iaas", opts.region);
  const url = (segments: string[], query?: Record<string, string>) => ociUrl(iaas, ["20160918", ...segments], query);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const changes: string[] = [];
  const retry = (step: string) => ({ "opc-retry-token": `${opts.retrySeed}-${step}`.slice(0, 64) });

  async function waitAvailable<T extends { lifecycleState: string }>(path: string[], initial: T): Promise<T> {
    let current = initial;
    for (let i = 0; current.lifecycleState !== "AVAILABLE"; i++) {
      if (i >= (opts.pollAttempts ?? 30)) throw new Error(`${path.join("/")} did not become AVAILABLE (last: ${current.lifecycleState})`);
      await sleep(opts.pollDelayMs ?? 2000);
      current = await client.request<T>("GET", url(path));
    }
    return current;
  }

  // 1. VCN
  const vcns = (await client.listAll<Vcn>(url(["vcns"], { compartmentId: opts.compartmentId, displayName: NAMES.vcn }))).filter(LIVE);
  let vcn = vcns[0];
  if (!vcn) {
    vcn = await client.request<Vcn>(
      "POST",
      url(["vcns"]),
      { compartmentId: opts.compartmentId, cidrBlocks: [VCN_CIDR], displayName: NAMES.vcn, dnsLabel: "easycloud", freeformTags: TAGS },
      retry("vcn"),
    );
    changes.push("created network");
  }
  vcn = await waitAvailable(["vcns", vcn.id], vcn);

  // 2. Internet gateway
  const scope = { compartmentId: opts.compartmentId, vcnId: vcn.id };
  const gateways = (await client.listAll<Gateway>(url(["internetGateways"], scope))).filter(LIVE);
  let igw = gateways.find((g) => g.isEnabled !== false);
  const disabled = gateways.find((g) => g.isEnabled === false);
  if (!igw && disabled) {
    // A VCN can have only one internet gateway: re-enable it instead of creating another.
    igw = await client.request<Gateway>("PUT", url(["internetGateways", disabled.id]), { isEnabled: true });
    changes.push("enabled internet gateway");
  }
  if (!igw) {
    igw = await client.request<Gateway>(
      "POST",
      url(["internetGateways"]),
      { ...scope, isEnabled: true, displayName: NAMES.igw, freeformTags: TAGS },
      retry("igw"),
    );
    changes.push("created internet gateway");
  }
  igw = await waitAvailable(["internetGateways", igw.id], igw);

  // 3. Default route table: 0.0.0.0/0 -> internet gateway
  const routeTable = await client.request<RouteTable>("GET", url(["routeTables", vcn.defaultRouteTableId]));
  const defaultRoute = routeTable.routeRules.find((r) => r.destination === ANYWHERE);
  if (!defaultRoute || defaultRoute.networkEntityId !== igw.id) {
    const routeRules = [
      ...routeTable.routeRules.filter((r) => r.destination !== ANYWHERE),
      { destination: ANYWHERE, destinationType: "CIDR_BLOCK", networkEntityId: igw.id, description: "Internet access (easycloud)" },
    ];
    await client.request("PUT", url(["routeTables", routeTable.id]), { routeRules });
    changes.push("routed internet traffic through the gateway");
  }

  // 4. Default security list: SSH (TCP 22) in from anywhere
  const securityList = await client.request<SecurityList>("GET", url(["securityLists", vcn.defaultSecurityListId]));
  const hasSsh = securityList.ingressSecurityRules.some(
    (r) => r.protocol === "6" && r.source === ANYWHERE && portRangeIncludes(r.tcpOptions?.destinationPortRange, 22),
  );
  if (!hasSsh) {
    const ingressSecurityRules = [
      ...securityList.ingressSecurityRules,
      {
        protocol: "6",
        source: ANYWHERE,
        sourceType: "CIDR_BLOCK",
        isStateless: false,
        tcpOptions: { destinationPortRange: { min: 22, max: 22 } },
        description: "SSH (easycloud)",
      },
    ];
    await client.request("PUT", url(["securityLists", securityList.id]), { ingressSecurityRules });
    changes.push("allowed SSH");
  }

  // 5. Public regional subnet
  const subnets = (await client.listAll<Subnet>(url(["subnets"], { ...scope, displayName: NAMES.subnet }))).filter(LIVE);
  let subnet = subnets[0];
  if (!subnet) {
    subnet = await client.request<Subnet>(
      "POST",
      url(["subnets"]),
      {
        ...scope,
        cidrBlock: SUBNET_CIDR,
        displayName: NAMES.subnet,
        dnsLabel: "public",
        prohibitPublicIpOnVnic: false,
        routeTableId: vcn.defaultRouteTableId,
        securityListIds: [vcn.defaultSecurityListId],
        freeformTags: TAGS,
      },
      retry("subnet"),
    );
    changes.push("created public subnet");
  }
  subnet = await waitAvailable(["subnets", subnet.id], subnet);

  return { vcnId: vcn.id, subnetId: subnet.id, changes };
}

function portRangeIncludes(range: { min: number; max: number } | undefined, port: number): boolean {
  // An absent range on a TCP rule means all ports.
  return !range || (range.min <= port && port <= range.max);
}
