/**
 * M5: deployment state machine. The Account Durable Object stores a Deployment
 * and calls advance() from its alarm. Each server keeps its own next-attempt
 * time; advance() steps only the servers that are due (one OCI action each),
 * records the outcome, and returns the delay until the next due server (null
 * when finished). Capacity failures rotate availability domains and retry
 * indefinitely; 429s back off; fatal errors stop only the affected server.
 */
import { OciError, type OciClient } from "./oci/client";
import { ensureNetwork } from "./oci/network";
import { ociEndpoint, ociUrl } from "./oci/url";
import type { LayoutPlan, NetworkPlan, PlannedInstance } from "./plan";
import type { ComponentSelection } from "./vm/components";

export const TAGS = { easycloud: "managed" };
/** Freeform tag tying an instance to the deployment run that launched it (used for safe adoption). */
export const RUN_TAG = "easycloud-run";
const LOG_LIMIT = 50;

/**
 * Oracle's default boot volume for these images is 47 GB (Always Free docs); a *custom* size must
 * be at least 50 GB (InstanceSourceViaImageDetails.bootVolumeSizeInGBs). Sizes at or below the
 * default are therefore sent as "no custom size".
 */
export const IMAGE_DEFAULT_BOOT_GB = 47;
export const CUSTOM_BOOT_MIN_GB = 50;

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
  /** Give up on an instance that has not reached RUNNING after this long. */
  provisioningTimeoutMs: 30 * 60_000,
  /** RUNNING polls to wait for a public IP before finishing without one. */
  ipPolls: 20,
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
  /** When this server is next due for an action (ISO); absent = due now. */
  nextAttemptAt?: string;
  provisioningSince?: string;
  ipPollCount?: number;
  instanceId?: string;
  availabilityDomain?: string;
  publicIp?: string;
  message?: string;
}

export interface Deployment {
  status: "network" | "servers" | "done" | "failed" | "cancelled";
  /** Unique per deployment run; tagged onto launched instances. */
  runId: string;
  createdAt: string;
  updatedAt: string;
  region: string;
  compartmentId: string;
  sshPublicKey: string;
  /** Selected VM components without secrets (tokens/keys live only in sealedUserData). */
  components: ComponentSelection;
  /** Per server name: envelope-sealed base64 cloud-init script (contains secrets). */
  sealedUserData?: Record<string, string>;
  network: NetworkPlan;
  subnetId?: string;
  servers: ServerItem[];
  backoffMs: number;
  nextAttemptAt?: string;
  log: { at: string; message: string }[];
}

export interface AdvanceDeps {
  client: OciClient;
  /** Per server name: base64 cloud-init script, decrypted by the caller. */
  userData?: Record<string, string>;
  now: () => Date;
  retrySeed: string;
  sleep?: (ms: number) => Promise<void>;
}

const SSH_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,3}(?: [^\r\n]*)?$/;

export function validSshPublicKey(key: string): boolean {
  return SSH_KEY.test(key.trim());
}

/**
 * Names for the servers to create, in plan order (A1 first, then micros). Numbers skip names that
 * existing instances already use, so a new server never shares a name with a live one.
 */
export function serverNames(plan: LayoutPlan): { name: string; role: PlannedInstance["role"] }[] {
  const taken = new Set([...plan.existing.a1, ...plan.existing.micros].map((i) => i.displayName));
  const next = (base: string, numbered: boolean) => {
    for (let n = 1; ; n++) {
      const name = n === 1 && !numbered ? base : `${base}-${n}`;
      if (!taken.has(name)) {
        taken.add(name);
        return name;
      }
    }
  };
  return plan.create.map((c) => ({ name: c.role === "a1" ? next("easycloud-a1", false) : next("easycloud-micro", true), role: c.role }));
}

export function newDeployment(
  plan: LayoutPlan,
  opts: {
    region: string;
    compartmentId: string;
    sshPublicKey: string;
    components: ComponentSelection;
    sealedUserData?: Record<string, string>;
    now: Date;
    runId?: string;
  },
): Deployment {
  const names = serverNames(plan);
  const servers = plan.create.map<ServerItem>((c, i) => ({
    name: names[i]!.name,
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
    runId: opts.runId ?? crypto.randomUUID(),
    createdAt: at,
    updatedAt: at,
    region: opts.region,
    compartmentId: opts.compartmentId,
    sshPublicKey: opts.sshPublicKey.trim(),
    components: opts.components,
    sealedUserData: opts.sealedUserData,
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

const finished = (s: ServerItem) => s.state === "running" || s.state === "failed";

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

  let rateLimited = false;
  for (const s of d.servers) {
    if (finished(s)) continue;
    if (s.nextAttemptAt && Date.parse(s.nextAttemptAt) > now.getTime()) continue;
    let delay: number;
    try {
      delay = await stepServer(d, s, deps, now);
    } catch (err) {
      if (!(err instanceof OciError)) throw err;
      const kind = classify(err);
      if (kind === "fatal") {
        s.state = "failed";
        s.message = fatalMessage(err);
        note(d, now, `${s.name}: ${s.message}`);
        delay = 0;
      } else if (kind === "rate") {
        rateLimited = true;
        delay = d.backoffMs;
      } else {
        delay = d.backoffMs;
        note(d, now, `${s.name}: Oracle error ${err.code}, will retry.`);
      }
    }
    s.nextAttemptAt = finished(s) ? undefined : new Date(now.getTime() + delay).toISOString();
  }

  if (rateLimited) {
    note(d, now, "Oracle asked EasyCloud to slow down; waiting before retrying.");
    d.backoffMs = Math.min(d.backoffMs * 2, PACING.backoffMaxMs);
  } else {
    d.backoffMs = PACING.backoffMinMs;
  }

  if (d.servers.every(finished)) {
    d.status = d.servers.some((s) => s.state === "running") || d.servers.length === 0 ? "done" : "failed";
    d.nextAttemptAt = undefined;
    note(d, now, d.status === "done" ? "All servers are set up." : "No server could be created.");
    return { deployment: d, nextDelayMs: null };
  }
  const due = Math.min(...d.servers.filter((s) => !finished(s)).map((s) => (s.nextAttemptAt ? Date.parse(s.nextAttemptAt) : now.getTime())));
  const delay = Math.max(PACING.stepMs, due - now.getTime());
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

interface Instance {
  id: string;
  lifecycleState: string;
  availabilityDomain: string;
  freeformTags?: Record<string, string>;
}

const GONE = new Set(["TERMINATED", "TERMINATING"]);
const STOPPED = new Set(["STOPPED", "STOPPING"]);

async function stepServer(d: Deployment, s: ServerItem, deps: AdvanceDeps, now: Date): Promise<number> {
  const iaas = ociEndpoint("iaas", d.region);
  const url = (segments: string[], query?: Record<string, string>) => ociUrl(iaas, ["20160918", ...segments], query);

  if (!s.instanceId) {
    // Adopt only an instance this run launched (its response was lost): same name AND this run's tag.
    const existing = (await deps.client.listAll<Instance>(url(["instances"], { compartmentId: d.compartmentId, displayName: s.name }))).find(
      (i) => !GONE.has(i.lifecycleState) && i.freeformTags?.[RUN_TAG] === d.runId,
    );
    if (existing) {
      s.instanceId = existing.id;
      s.availabilityDomain = existing.availabilityDomain;
      s.state = "provisioning";
      s.provisioningSince = now.toISOString();
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
          sourceDetails: {
            sourceType: "image",
            imageId: s.imageId,
            ...(s.bootVolumeGB > IMAGE_DEFAULT_BOOT_GB ? { bootVolumeSizeInGBs: s.bootVolumeGB } : {}),
          },
          createVnicDetails: { subnetId: d.subnetId, assignPublicIp: true },
          metadata: { ssh_authorized_keys: d.sshPublicKey, ...(deps.userData?.[s.name] ? { user_data: deps.userData[s.name] } : {}) },
          freeformTags: { ...TAGS, [RUN_TAG]: d.runId },
        },
        { "opc-retry-token": `${deps.retrySeed}-${s.name}-${s.attempts}`.slice(0, 64) },
      );
      s.instanceId = instance.id;
      s.availabilityDomain = ad;
      s.state = "provisioning";
      s.provisioningSince = now.toISOString();
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
    if (s.publicIp) {
      s.state = "running";
      s.message = undefined;
      note(d, now, `${s.name}: running at ${s.publicIp}.`);
      return PACING.stepMs;
    }
    s.ipPollCount = (s.ipPollCount ?? 0) + 1;
    if (s.ipPollCount < PACING.ipPolls) {
      s.message = "Running; waiting for its public IP address.";
      return PACING.provisioningMs;
    }
    s.state = "running";
    s.message = "Running, but Oracle assigned no public IP address. Check the server in the Oracle Console.";
    note(d, now, `${s.name}: ${s.message}`);
    return PACING.stepMs;
  }
  if (GONE.has(instance.lifecycleState)) {
    // Oracle can terminate a launch that failed after acceptance; start over.
    note(d, now, `${s.name}: Oracle stopped the launch; trying again.`);
    s.instanceId = undefined;
    s.provisioningSince = undefined;
    s.state = "waiting-capacity";
    s.adIndex++;
    return PACING.capacityMs;
  }
  if (STOPPED.has(instance.lifecycleState)) {
    s.state = "failed";
    s.message = "Oracle reports this server as stopped. Start it from the Oracle Console (Compute → Instances).";
    note(d, now, `${s.name}: ${s.message}`);
    return 0;
  }
  const since = s.provisioningSince ? Date.parse(s.provisioningSince) : now.getTime();
  if (now.getTime() - since > PACING.provisioningTimeoutMs) {
    s.state = "failed";
    s.message = `Oracle didn't finish starting this server within ${PACING.provisioningTimeoutMs / 60_000} minutes (state: ${instance.lifecycleState}). Check it in the Oracle Console.`;
    note(d, now, `${s.name}: ${s.message}`);
    return 0;
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
