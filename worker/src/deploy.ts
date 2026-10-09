/**
 * M5: deployment state machine. The Account Durable Object stores a Deployment
 * and calls advance() from its alarm; advance() performs at most one OCI action
 * per pending server, records the outcome, and returns the delay until the next
 * alarm (null when finished). Capacity failures rotate availability domains and
 * retry indefinitely; 429s back off; fatal errors stop only the affected server.
 */
import { OciError, type OciClient } from "./oci/client";
import { ensureNetwork } from "./oci/network";
import { ociEndpoint, ociUrl } from "./oci/url";
import type { LayoutPlan, NetworkPlan, PlannedInstance } from "./plan";

export const TAGS = { easycloud: "managed" };
const LOG_LIMIT = 50;

export const PACING = {
  /** Delay between capacity retries for the same server (each retry tries the next AD). */
  capacityMs: 60_000,
  /** Poll interval while an instance is provisioning. */
  provisioningMs: 15_000,
  /** Short pause between immediate follow-up steps. */
  stepMs: 1_000,
  /** Backoff bounds for 429 / transient errors. */
  backoffMinMs: 60_000,
  backoffMaxMs: 15 * 60_000,
} as const;

export type ServerState = "queued" | "waiting-capacity" | "provisioning" | "running" | "failed";

export interface ServerItem {
  name: string;
  role: PlannedInstance["role"];
  shape: string;
  ocpus?: number;
  memoryInGBs?: number;
  bootVolumeGB: number;
  imageId: string;
  candidateAds: string[];
  adIndex: number;
  attempts: number;
  state: ServerState;
  instanceId?: string;
  availabilityDomain?: string;
  publicIp?: string;
  message?: string;
}

export interface Deployment {
  status: "network" | "servers" | "done" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  region: string;
  compartmentId: string;
  sshPublicKey: string;
  userData?: string;
  network: NetworkPlan;
  subnetId?: string;
  servers: ServerItem[];
  backoffMs: number;
  nextAttemptAt?: string;
  log: { at: string; message: string }[];
}

export interface AdvanceDeps {
  client: OciClient;
  now: () => Date;
  retrySeed: string;
  sleep?: (ms: number) => Promise<void>;
}

const SSH_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,3}(?: [^\r\n]*)?$/;

export function validSshPublicKey(key: string): boolean {
  return SSH_KEY.test(key.trim());
}

export function newDeployment(
  plan: LayoutPlan,
  opts: { region: string; compartmentId: string; sshPublicKey: string; userData?: string; now: Date },
): Deployment {
  let micro = 0;
  const servers = plan.create.map<ServerItem>((c) => ({
    name: c.role === "a1" ? "easycloud-a1" : `easycloud-micro-${++micro}`,
    role: c.role,
    shape: c.shape,
    ocpus: c.ocpus,
    memoryInGBs: c.memoryInGBs,
    bootVolumeGB: c.bootVolumeGB,
    imageId: c.image!.id,
    candidateAds: c.candidateAds,
    adIndex: 0,
    attempts: 0,
    state: "queued",
  }));
  const at = opts.now.toISOString();
  return {
    status: plan.network.action === "reuse" ? "servers" : "network",
    createdAt: at,
    updatedAt: at,
    region: opts.region,
    compartmentId: opts.compartmentId,
    sshPublicKey: opts.sshPublicKey.trim(),
    userData: opts.userData,
    network: plan.network,
    subnetId: plan.network.action === "reuse" ? plan.network.subnetId : undefined,
    servers,
    backoffMs: PACING.backoffMinMs,
    log: [{ at, message: `Planned ${servers.length} server(s).` }],
  };
}

type Outcome = "capacity" | "rate" | "transient" | "fatal";

export function classify(err: OciError): Outcome {
  if (err.status === 500 && /out of host capacity/i.test(err.message)) return "capacity";
  if (err.status === 429) return "rate";
  if (err.status >= 500 || (err.status === 409 && err.code === "IncorrectState")) return "transient";
  return "fatal";
}

function fatalMessage(err: OciError): string {
  if (err.code === "LimitExceeded" || err.code === "QuotaExceeded") return "Oracle says this account has no free allowance left for this server.";
  if (err.status === 401) return "Oracle no longer accepts EasyCloud's key (was it removed from the account?).";
  if (err.status === 404) return "Oracle refused access (the key's user may not be an administrator).";
  return `Oracle rejected the request: ${err.code}: ${err.message}`;
}

function note(d: Deployment, at: Date, message: string) {
  d.log.push({ at: at.toISOString(), message });
  if (d.log.length > LOG_LIMIT) d.log.splice(0, d.log.length - LOG_LIMIT);
}

/** One step. Mutates and returns the deployment plus the delay before the next step (null = finished). */
export async function advance(d: Deployment, deps: AdvanceDeps): Promise<{ deployment: Deployment; nextDelayMs: number | null }> {
  const now = deps.now();
  d.updatedAt = now.toISOString();
  if (d.status === "done" || d.status === "failed" || d.status === "cancelled") return { deployment: d, nextDelayMs: null };

  if (d.status === "network") {
    try {
      const net = await ensureNetwork(deps.client, {
        region: d.region,
        compartmentId: d.compartmentId,
        retrySeed: `${deps.retrySeed}-net`,
        sleep: deps.sleep,
      });
      d.subnetId = net.subnetId;
      d.status = "servers";
      note(d, now, net.changes.length ? `Network ready (${net.changes.join(", ")}).` : "Network ready.");
      return { deployment: d, nextDelayMs: PACING.stepMs };
    } catch (err) {
      if (!(err instanceof OciError)) throw err;
      const kind = classify(err);
      if (kind === "fatal") {
        d.status = "failed";
        note(d, now, `Network setup failed: ${fatalMessage(err)}`);
        return { deployment: d, nextDelayMs: null };
      }
      return backoff(d, now, `Network setup will retry (${err.code}).`);
    }
  }

  let delay = Infinity;
  let rateLimited = false;
  for (const s of d.servers) {
    if (s.state === "running" || s.state === "failed") continue;
    try {
      delay = Math.min(delay, await stepServer(d, s, deps, now));
    } catch (err) {
      if (!(err instanceof OciError)) throw err;
      const kind = classify(err);
      if (kind === "fatal") {
        s.state = "failed";
        s.message = fatalMessage(err);
        note(d, now, `${s.name}: ${s.message}`);
      } else if (kind === "rate") {
        rateLimited = true;
      } else {
        delay = Math.min(delay, d.backoffMs);
        note(d, now, `${s.name}: Oracle error ${err.code}, will retry.`);
      }
    }
  }

  if (rateLimited) return backoff(d, now, "Oracle asked EasyCloud to slow down; waiting before retrying.");
  d.backoffMs = PACING.backoffMinMs;

  if (d.servers.every((s) => s.state === "running" || s.state === "failed")) {
    d.status = d.servers.some((s) => s.state === "running") || d.servers.length === 0 ? "done" : "failed";
    d.nextAttemptAt = undefined;
    note(d, now, d.status === "done" ? "All servers are set up." : "No server could be created.");
    return { deployment: d, nextDelayMs: null };
  }
  d.nextAttemptAt = new Date(now.getTime() + delay).toISOString();
  return { deployment: d, nextDelayMs: delay };
}

function backoff(d: Deployment, now: Date, message: string) {
  const delay = d.backoffMs;
  d.backoffMs = Math.min(d.backoffMs * 2, PACING.backoffMaxMs);
  d.nextAttemptAt = new Date(now.getTime() + delay).toISOString();
  note(d, now, message);
  return { deployment: d, nextDelayMs: delay };
}

interface Instance { id: string; lifecycleState: string; availabilityDomain: string }

async function stepServer(d: Deployment, s: ServerItem, deps: AdvanceDeps, now: Date): Promise<number> {
  const iaas = ociEndpoint("iaas", d.region);
  const url = (segments: string[], query?: Record<string, string>) => ociUrl(iaas, ["20160918", ...segments], query);

  if (!s.instanceId) {
    // Adopt an instance from an earlier attempt whose response was lost.
    const existing = (await deps.client.listAll<Instance>(url(["instances"], { compartmentId: d.compartmentId, displayName: s.name }))).find(
      (i) => i.lifecycleState !== "TERMINATED" && i.lifecycleState !== "TERMINATING",
    );
    if (existing) {
      s.instanceId = existing.id;
      s.availabilityDomain = existing.availabilityDomain;
      s.state = "provisioning";
      return PACING.stepMs;
    }

    const ad = s.candidateAds[s.adIndex % s.candidateAds.length]!;
    s.attempts++;
    try {
      const instance = await deps.client.request<Instance>(
        "POST",
        url(["instances"]),
        {
          availabilityDomain: ad,
          compartmentId: d.compartmentId,
          displayName: s.name,
          shape: s.shape,
          ...(s.ocpus ? { shapeConfig: { ocpus: s.ocpus, memoryInGBs: s.memoryInGBs } } : {}),
          sourceDetails: { sourceType: "image", imageId: s.imageId, bootVolumeSizeInGBs: s.bootVolumeGB },
          createVnicDetails: { subnetId: d.subnetId, assignPublicIp: true },
          metadata: { ssh_authorized_keys: d.sshPublicKey, ...(d.userData ? { user_data: d.userData } : {}) },
          freeformTags: TAGS,
        },
        { "opc-retry-token": `${deps.retrySeed}-${s.name}-${s.attempts}`.slice(0, 64) },
      );
      s.instanceId = instance.id;
      s.availabilityDomain = ad;
      s.state = "provisioning";
      s.message = undefined;
      note(d, now, `${s.name}: Oracle accepted the request in ${ad} (attempt ${s.attempts}).`);
      return PACING.provisioningMs;
    } catch (err) {
      if (err instanceof OciError && classify(err) === "capacity") {
        s.state = "waiting-capacity";
        s.adIndex++;
        s.message = `Waiting for Oracle to free up capacity (attempt ${s.attempts}).`;
        if (s.attempts === 1 || s.attempts % 60 === 0) note(d, now, `${s.name}: no capacity yet; EasyCloud keeps trying.`);
        return PACING.capacityMs;
      }
      throw err;
    }
  }

  const instance = await deps.client.request<Instance>("GET", url(["instances", s.instanceId]));
  if (instance.lifecycleState === "RUNNING") {
    s.publicIp = await publicIp(deps.client, url, d.compartmentId, s.instanceId);
    s.state = "running";
    s.message = undefined;
    note(d, now, `${s.name}: running${s.publicIp ? ` at ${s.publicIp}` : ""}.`);
    return PACING.stepMs;
  }
  if (instance.lifecycleState === "TERMINATED" || instance.lifecycleState === "TERMINATING") {
    // Oracle can terminate a launch that failed after acceptance; start over.
    note(d, now, `${s.name}: Oracle stopped the launch; trying again.`);
    s.instanceId = undefined;
    s.state = "waiting-capacity";
    s.adIndex++;
    return PACING.capacityMs;
  }
  return PACING.provisioningMs;
}

async function publicIp(
  client: OciClient,
  url: (segments: string[], query?: Record<string, string>) => string,
  compartmentId: string,
  instanceId: string,
): Promise<string | undefined> {
  const attachments = await client.listAll<{ vnicId: string; lifecycleState: string }>(url(["vnicAttachments"], { compartmentId, instanceId }));
  const attached = attachments.find((a) => a.lifecycleState === "ATTACHED");
  if (!attached) return undefined;
  const vnic = await client.request<{ publicIp?: string }>("GET", url(["vnics", attached.vnicId]));
  return vnic.publicIp;
}
