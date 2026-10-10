/**
 * Durable Object interleaving: the alarm awaits Oracle (input gate open), so a cancel or a new
 * deployment can land meanwhile. The alarm must not write its stale snapshot back or re-arm.
 * Uses the real Account DO, runDurableObjectAlarm, and a gated global fetch routed to FakeOci.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Account } from "../src/account";
import { newDeployment, type Deployment } from "../src/deploy";
import { SHAPES } from "../src/oci/discovery";
import type { LayoutPlan } from "../src/plan";
import { FakeOci } from "./helpers/fake-oci";

const SSH = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGzW0X0h4d3l9vHqmGQyQ1nB0p6tZQkzv3a2w8m3E1c7 phone";
const IMG = { id: "img-a1", displayName: "u-a1", operatingSystemVersion: "24.04 Minimal aarch64" };

function plan(): LayoutPlan {
  return {
    storage: { allowanceGB: 200, usedGB: 0, freeGB: 200 },
    existing: { a1: [], micros: [] },
    create: [{ role: "a1", shape: SHAPES.a1, ocpus: 2, memoryInGBs: 12, bootVolumeGB: 106, image: IMG, candidateAds: ["AD-1", "AD-2", "AD-3"] }],
    network: { action: "reuse", vcnId: "v", subnetId: "s", displayName: "n" },
    blockers: [],
    notes: [],
  };
}

const deployment = (tenancy: string, now: Date) =>
  newDeployment(plan(), { region: "us-ashburn-1", compartmentId: tenancy, sshPublicKey: SSH, components: {}, now });

/** Cross-context signalling via flags polled with timers. */
function flag() {
  const f = { set: false };
  return {
    f,
    wait: async () => {
      while (!f.set) await new Promise((r) => setTimeout(r, 5));
    },
  };
}

async function seed(name: string, tenancy: string) {
  const stub = env.ACCOUNTS.getByName(name);
  await stub.create(name);
  await runInDurableObject(stub, async (_i: Account, state: DurableObjectState) => {
    const rec = (await state.storage.get<Record<string, unknown>>("account"))!;
    await state.storage.put("account", {
      ...rec,
      accountId: name,
      state: "connected",
      tenancy,
      user: "ocid1.user.oc1..u",
      homeRegion: "us-ashburn-1",
      availabilityDomains: ["AD-1", "AD-2", "AD-3"],
    });
    await state.storage.put("deployment", deployment(tenancy, new Date()));
    await state.storage.setAlarm(Date.now() + 60_000);
  });
  return stub;
}

/** Routes OCI calls to the fake; the first call blocks until `gate` is released. */
function stubOci(fake: FakeOci) {
  const entered = flag();
  const gate = flag();
  let first = true;
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (first) {
      first = false;
      entered.f.set = true;
      await gate.wait();
    }
    return fake.handle(req);
  });
  return { entered, gate };
}

afterEach(() => vi.unstubAllGlobals());

describe("alarm vs cancel/deploy interleaving", () => {
  it("a cancel accepted while the alarm awaits Oracle stays cancelled and nothing re-arms", async () => {
    const stub = await seed("RaceCancelAAAAAAAAAAAA", "ocid1.tenancy.oc1..race1");
    const { entered, gate } = stubOci(new FakeOci()); // no capacity: the launch fails with "Out of host capacity"

    const alarmRun = runDurableObjectAlarm(stub);
    await entered.wait();
    expect((await stub.cancel())?.status).toBe("cancelled");
    gate.f.set = true;
    expect(await alarmRun).toBe(true);

    expect(((await stub.deployment()) as Deployment).status).toBe("cancelled");
    expect(await runInDurableObject(stub, (_i: Account, s: DurableObjectState) => s.storage.getAlarm())).toBeNull();
  });

  it("a deployment written meanwhile is not overwritten by the old run's alarm", async () => {
    const tenancy = "ocid1.tenancy.oc1..race2";
    const stub = await seed("RaceRedeployAAAAAAAAAA", tenancy);
    const { entered, gate } = stubOci(new FakeOci());

    const alarmRun = runDurableObjectAlarm(stub);
    await entered.wait();
    await stub.cancel();
    const fresh = deployment(tenancy, new Date(Date.now() + 5_000));
    await runInDurableObject(stub, async (_i: Account, s: DurableObjectState) => {
      await s.storage.put("deployment", fresh);
    });
    gate.f.set = true;
    await alarmRun;

    const after = (await stub.deployment()) as Deployment;
    expect(after.runId).toBe(fresh.runId);
    expect(after.servers[0]!.attempts).toBe(0);
  });
});
