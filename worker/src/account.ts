import { DurableObject } from "cloudflare:workers";
import { importDataKey } from "./crypto/envelope";
import type { Env } from "./env";
import { connectAccount, createAccount, getAccount, type OnboardingDeps } from "./onboarding";
import { planAccount } from "./planning";

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
}
