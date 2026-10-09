import { DurableObject } from "cloudflare:workers";
import { importDataKey } from "./crypto/envelope";
import { advance, newDeployment, PACING, validSshPublicKey, type Deployment } from "./deploy";
import type { Env } from "./env";
import {
  clientFor,
  connectAccount,
  createAccount,
  getAccount,
  RECORD_KEY,
  type AccountRecord,
  type OnboardingDeps,
} from "./onboarding";
import { planAccount } from "./planning";

const DEPLOYMENT = "deployment";

export type DeployResult =
  | { ok: true; deployment: Deployment }
  | { ok: false; error: { kind: string; message: string; details?: string[] } };

/** One Durable Object per onboarding (named by the capability id in the setup link). */
export class Account extends DurableObject<Env> {
  private async deps(accountId: string): Promise<OnboardingDeps> {
    return { storage: this.ctx.storage, dataKey: await importDataKey(this.env.KEY_ENCRYPTION_KEY), accountId };
  }

  async create(accountId: string) {
    return createAccount(await this.deps(accountId));
  }

  async status(accountId: string) {
    return getAccount(await this.deps(accountId));
  }

  async connectOci(accountId: string, preview: string) {
    return connectAccount(await this.deps(accountId), preview);
  }

  async plan(accountId: string) {
    return planAccount(await this.deps(accountId));
  }

  async deploy(accountId: string, sshPublicKey: string): Promise<DeployResult> {
    if (!validSshPublicKey(sshPublicKey)) {
      return { ok: false, error: { kind: "invalid-ssh-key", message: "That doesn't look like an SSH public key. Copy the public key (it starts with ssh-ed25519) from Termius." } };
    }
    const existing = await this.ctx.storage.get<Deployment>(DEPLOYMENT);
    if (existing && (existing.status === "network" || existing.status === "servers")) {
      return { ok: false, error: { kind: "already-running", message: "Setup is already running." } };
    }
    const record = await this.ctx.storage.get<AccountRecord>(RECORD_KEY);
    const planned = await planAccount(await this.deps(accountId));
    if (!planned.ok) return { ok: false, error: planned.error };
    if (planned.plan.blockers.length) {
      return { ok: false, error: { kind: "blocked", message: "EasyCloud can't set up servers yet.", details: planned.plan.blockers } };
    }
    if (!planned.plan.create.length) {
      return { ok: false, error: { kind: "nothing-to-do", message: "The free servers already exist in this account." } };
    }
    const deployment = newDeployment(planned.plan, {
      region: record!.homeRegion!,
      compartmentId: record!.tenancy!,
      sshPublicKey,
      now: new Date(),
    });
    await this.ctx.storage.put(DEPLOYMENT, deployment);
    await this.ctx.storage.setAlarm(Date.now() + PACING.stepMs);
    return { ok: true, deployment };
  }

  async deployment(): Promise<Deployment | undefined> {
    return this.ctx.storage.get<Deployment>(DEPLOYMENT);
  }

  async cancel(): Promise<Deployment | undefined> {
    const d = await this.ctx.storage.get<Deployment>(DEPLOYMENT);
    if (!d || d.status === "done" || d.status === "failed" || d.status === "cancelled") return d;
    d.status = "cancelled";
    d.nextAttemptAt = undefined;
    d.log.push({ at: new Date().toISOString(), message: "Setup cancelled. Servers already created were left in place." });
    await this.ctx.storage.put(DEPLOYMENT, d);
    await this.ctx.storage.deleteAlarm();
    return d;
  }

  override async alarm(): Promise<void> {
    const d = await this.ctx.storage.get<Deployment>(DEPLOYMENT);
    const record = await this.ctx.storage.get<AccountRecord>(RECORD_KEY);
    if (!d || !record?.accountId || !record.tenancy || !record.user) return;
    let next: number | null;
    try {
      const deps = await this.deps(record.accountId);
      const client = await clientFor(deps, record, { tenancy: record.tenancy, user: record.user });
      next = (await advance(d, { client, now: () => new Date(), retrySeed: `${record.accountId.slice(0, 12)}-${Date.parse(d.createdAt)}` })).nextDelayMs;
    } catch (err) {
      // Unexpected failure (network error, bug): keep the loop alive with backoff instead of losing it.
      next = d.backoffMs;
      d.backoffMs = Math.min(d.backoffMs * 2, PACING.backoffMaxMs);
      d.log.push({ at: new Date().toISOString(), message: `Temporary problem (${err instanceof Error ? err.message : String(err)}); retrying.` });
      if (d.log.length > 50) d.log.splice(0, d.log.length - 50);
    }
    await this.ctx.storage.put(DEPLOYMENT, d);
    if (next !== null) await this.ctx.storage.setAlarm(Date.now() + next);
  }
}
