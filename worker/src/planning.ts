/** M3: read-only discovery of a connected account plus the layout plan. */
import { OciError } from "./oci/client";
import { discover, type Discovery } from "./oci/discovery";
import { clientFor, describeOciError, RECORD_KEY, type AccountRecord, type ConnectError, type OnboardingDeps } from "./onboarding";
import { planLayout, type LayoutPlan } from "./plan";

export type PlanResult =
  | { ok: true; plan: LayoutPlan; discovery: Pick<Discovery, "region" | "availabilityDomains" | "vcnCount" | "storageUsedGB" | "limits" | "images"> }
  | { ok: false; error: ConnectError | { kind: "not-connected"; message: string } };

export async function planAccount(deps: OnboardingDeps): Promise<PlanResult> {
  const record = await deps.storage.get<AccountRecord>(RECORD_KEY);
  if (!record || record.state !== "connected" || !record.tenancy || !record.user || !record.homeRegion) {
    return { ok: false, error: { kind: "not-connected", message: "Connect your Oracle account first." } };
  }
  const client = await clientFor(deps, record, { tenancy: record.tenancy, user: record.user });
  try {
    const d = await discover(client, record.homeRegion, record.tenancy, record.availabilityDomains ?? []);
    const { region, availabilityDomains, vcnCount, storageUsedGB, limits, images } = d;
    return { ok: true, plan: planLayout(d), discovery: { region, availabilityDomains, vcnCount, storageUsedGB, limits, images } };
  } catch (err) {
    if (err instanceof OciError) return { ok: false, error: describeOciError(err) };
    throw err;
  }
}
