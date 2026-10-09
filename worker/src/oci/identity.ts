/** Identity API (20160918) calls used during onboarding. */
import type { OciClient } from "./client";
import { ociEndpoint, ociUrl } from "./url";

export interface RegionSubscription {
  regionKey: string;
  regionName: string;
  status: string;
  isHomeRegion: boolean;
}

export interface AvailabilityDomain {
  name: string;
  id: string;
  compartmentId: string;
}

export function listRegionSubscriptions(client: OciClient, region: string, tenancyOcid: string) {
  return client.request<RegionSubscription[]>(
    "GET",
    ociUrl(ociEndpoint("identity", region), ["20160918", "tenancies", tenancyOcid, "regionSubscriptions"]),
  );
}

export async function homeRegion(client: OciClient, anySubscribedRegion: string, tenancyOcid: string): Promise<string> {
  const subs = await listRegionSubscriptions(client, anySubscribedRegion, tenancyOcid);
  const home = subs.find((s) => s.isHomeRegion);
  if (!home) throw new Error("No home region in region subscriptions");
  return home.regionName;
}

export function listAvailabilityDomains(client: OciClient, region: string, tenancyOcid: string) {
  return client.request<AvailabilityDomain[]>(
    "GET",
    ociUrl(ociEndpoint("identity", region), ["20160918", "availabilityDomains"], { compartmentId: tenancyOcid }),
  );
}
