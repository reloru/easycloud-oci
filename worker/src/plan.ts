/**
 * Layout planner (pure): decides what to create from a Discovery snapshot.
 * Rules: the A1 is created first (scarcest shape); storage for each planned
 * micro (minimum boot volume) is reserved before sizing the A1 boot volume;
 * an existing internet-routed public subnet is reused before creating a VCN.
 */
import { SHAPES, type Discovery, type ImageSummary, type InstanceSummary } from "./oci/discovery";

export interface Allowance {
  a1Ocpus: number;
  a1MemoryGB: number;
  microCount: number;
  storageGB: number;
  vcnLimit: number;
  minBootGB: number;
}

/** Documented Always Free allowance (since 2026-06-15) — see docs/PLAN.md → Platform facts. */
export const ALWAYS_FREE: Allowance = { a1Ocpus: 2, a1MemoryGB: 12, microCount: 2, storageGB: 200, vcnLimit: 2, minBootGB: 47 };

export interface Wanted {
  a1: boolean;
  micros: number;
}

export interface PlannedInstance {
  role: "a1" | "micro";
  shape: string;
  ocpus?: number;
  memoryInGBs?: number;
  bootVolumeGB: number;
  image?: ImageSummary;
  candidateAds: string[];
}

export type NetworkPlan =
  | { action: "none" }
  | { action: "reuse"; vcnId: string; subnetId: string; displayName: string }
  | { action: "create" }
  | { action: "blocked"; reason: string };

export interface LayoutPlan {
  storage: { allowanceGB: number; usedGB: number; freeGB: number };
  existing: { a1: InstanceSummary[]; micros: InstanceSummary[] };
  create: PlannedInstance[];
  network: NetworkPlan;
  blockers: string[];
  notes: string[];
}

function adsWithLimit(d: Discovery, limitName: string): string[] {
  const scoped = d.limits.filter((l) => l.name === limitName && l.scopeType === "AD" && l.availabilityDomain);
  if (!scoped.length) return d.availabilityDomains;
  const positive = scoped.filter((l) => l.value > 0).map((l) => l.availabilityDomain!);
  return positive.length ? positive : d.availabilityDomains;
}

export function planLayout(d: Discovery, allowance: Allowance = ALWAYS_FREE, want: Wanted = { a1: true, micros: 2 }): LayoutPlan {
  const blockers: string[] = [];
  const notes: string[] = [];
  const existingA1 = d.instances.filter((i) => i.shape === SHAPES.a1);
  const existingMicros = d.instances.filter((i) => i.shape === SHAPES.micro);

  const freeGB = Math.max(0, allowance.storageGB - d.storageUsedGB);
  const remOcpus = Math.floor(allowance.a1Ocpus - existingA1.reduce((s, i) => s + i.ocpus, 0));
  const remMemory = Math.floor(allowance.a1MemoryGB - existingA1.reduce((s, i) => s + i.memoryInGBs, 0));
  // A1 needs at least 1 GB of memory per OCPU.
  const a1Ocpus = Math.min(remOcpus, remMemory);
  const wantA1 = want.a1 && a1Ocpus >= 1;
  if (want.a1 && !wantA1 && existingA1.length === 0) blockers.push("No Ampere (A1) allowance is left in this account.");
  const microsWanted = Math.max(0, Math.min(want.micros, allowance.microCount - existingMicros.length));

  const min = allowance.minBootGB;
  let createA1 = false;
  let microsFit = 0;
  let a1Boot = 0;
  if (wantA1 && freeGB >= min) {
    createA1 = true;
    microsFit = Math.min(microsWanted, Math.floor((freeGB - min) / min));
    a1Boot = freeGB - microsFit * min;
  } else {
    if (wantA1) blockers.push(`Not enough free storage for a server: ${freeGB} GB free, ${min} GB needed.`);
    microsFit = Math.min(microsWanted, Math.floor(freeGB / min));
  }
  if (microsFit < microsWanted) {
    notes.push(`Only ${microsFit} of ${microsWanted} small (AMD) servers fit in the remaining storage.`);
  }

  const create: PlannedInstance[] = [];
  if (createA1) {
    create.push({
      role: "a1",
      shape: SHAPES.a1,
      ocpus: a1Ocpus,
      memoryInGBs: remMemory,
      bootVolumeGB: a1Boot,
      image: d.images.a1,
      candidateAds: adsWithLimit(d, "standard-a1-core-count"),
    });
  }
  for (let i = 0; i < microsFit; i++) {
    create.push({
      role: "micro",
      shape: SHAPES.micro,
      bootVolumeGB: min,
      image: d.images.micro,
      candidateAds: adsWithLimit(d, "standard-e2-micro-core-count"),
    });
  }
  for (const role of new Set(create.map((c) => c.role))) {
    if (!create.find((c) => c.role === role)?.image) blockers.push(`No Ubuntu 24.04 Minimal image found for the ${role === "a1" ? "Ampere" : "AMD"} server.`);
  }

  let network: NetworkPlan = { action: "none" };
  if (create.length) {
    const reusable = d.networks.find((n) => n.publicSubnets.length > 0);
    if (reusable) {
      network = { action: "reuse", vcnId: reusable.vcnId, subnetId: reusable.publicSubnets[0]!.id, displayName: reusable.displayName };
    } else if (d.vcnCount < allowance.vcnLimit) {
      network = { action: "create" };
    } else {
      network = {
        action: "blocked",
        reason: `This account already has ${d.vcnCount} networks (the free limit) and none can reach the internet. Delete an unused one in the Oracle Console under Networking → Virtual cloud networks.`,
      };
      blockers.push(network.reason);
    }
  } else if (!blockers.length) {
    notes.push("Nothing to create: the free servers already exist.");
  }

  return {
    storage: { allowanceGB: allowance.storageGB, usedGB: d.storageUsedGB, freeGB },
    existing: { a1: existingA1, micros: existingMicros },
    create,
    network,
    blockers,
    notes,
  };
}
