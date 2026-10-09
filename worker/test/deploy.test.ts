import { describe, expect, it } from "vitest";
import { advance, classify, newDeployment, PACING, validSshPublicKey, type Deployment } from "../src/deploy";
import { OciError } from "../src/oci/client";
import { SHAPES } from "../src/oci/discovery";
import type { LayoutPlan } from "../src/plan";
import { FakeOci, fakeClient } from "./helpers/fake-oci";

const C = "ocid1.tenancy.oc1..root";
const ADS = ["AD-1", "AD-2", "AD-3"];
const SSH = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGzW0X0h4d3l9vHqmGQyQ1nB0p6tZQkzv3a2w8m3E1c7 phone";
const IMG = { a1: { id: "img-a1", displayName: "u-a1", operatingSystemVersion: "24.04 Minimal aarch64" }, micro: { id: "img-m", displayName: "u-m", operatingSystemVersion: "24.04 Minimal" } };

function plan(network: LayoutPlan["network"] = { action: "create" }): LayoutPlan {
  return {
    storage: { allowanceGB: 200, usedGB: 0, freeGB: 200 },
    existing: { a1: [], micros: [] },
    create: [
      { role: "a1", shape: SHAPES.a1, ocpus: 2, memoryInGBs: 12, bootVolumeGB: 106, image: IMG.a1, candidateAds: ADS },
      { role: "micro", shape: SHAPES.micro, bootVolumeGB: 47, image: IMG.micro, candidateAds: ["AD-2"] },
      { role: "micro", shape: SHAPES.micro, bootVolumeGB: 47, image: IMG.micro, candidateAds: ["AD-2"] },
    ],
    network,
    blockers: [],
    notes: [],
  };
}

async function run(fake: FakeOci, d: Deployment, maxSteps = 200) {
  let t = Date.UTC(2026, 9, 9);
  const delays: number[] = [];
  const deps = { client: await fakeClient(fake), now: () => new Date(t), retrySeed: "acct", sleep: async () => {} };
  for (let i = 0; i < maxSteps; i++) {
    const { nextDelayMs } = await advance(d, deps);
    if (nextDelayMs === null) return { delays, steps: i + 1 };
    delays.push(nextDelayMs);
    t += nextDelayMs;
  }
  throw new Error("did not finish");
}

const fresh = (p = plan()) => newDeployment(p, { region: "us-ashburn-1", compartmentId: C, sshPublicKey: SSH, now: new Date(Date.UTC(2026, 9, 9)) });

describe("deployment", () => {
  it("builds the network, rotates ADs on capacity errors, and ends with all servers running", async () => {
    const fake = new FakeOci();
    fake.capacity = new Set(["AD-2", "AD-3"]); // A1: AD-1 has no capacity
    const d = fresh();
    expect(d.status).toBe("network");
    await run(fake, d);

    expect(d.status).toBe("done");
    expect(d.servers.map((s) => [s.name, s.state, s.availabilityDomain])).toEqual([
      ["easycloud-a1", "running", "AD-2"],
      ["easycloud-micro-1", "running", "AD-2"],
      ["easycloud-micro-2", "running", "AD-2"],
    ]);
    expect(d.servers.every((s) => /^203\.0\.113\.\d+$/.test(s.publicIp ?? ""))).toBe(true);
    expect(fake.launches.map((l) => [l.body.displayName, l.ad])).toEqual([
      ["easycloud-a1", "AD-1"],
      ["easycloud-micro-1", "AD-2"],
      ["easycloud-micro-2", "AD-2"],
      ["easycloud-a1", "AD-2"],
    ]);
    const a1 = fake.launches.at(-1)!.body;
    expect(a1).toMatchObject({
      compartmentId: C,
      shape: SHAPES.a1,
      shapeConfig: { ocpus: 2, memoryInGBs: 12 },
      sourceDetails: { sourceType: "image", imageId: "img-a1", bootVolumeSizeInGBs: 106 },
      createVnicDetails: { subnetId: d.subnetId, assignPublicIp: true },
      metadata: { ssh_authorized_keys: SSH },
      freeformTags: { easycloud: "managed" },
    });
    expect(fake.launches[1]!.body).not.toHaveProperty("shapeConfig");
    expect(new Set(fake.launches.map((l) => l.token)).size).toBe(fake.launches.length);
  });

  it("keeps retrying for capacity at the capacity pace until a slot appears", async () => {
    const fake = new FakeOci();
    const d = fresh(plan({ action: "reuse", vcnId: "v", subnetId: "s", displayName: "n" }));
    d.servers = d.servers.slice(0, 1);
    let t = Date.UTC(2026, 9, 9);
    const deps = { client: await fakeClient(fake), now: () => new Date(t), retrySeed: "acct" };
    for (let i = 0; i < 7; i++) {
      const { nextDelayMs } = await advance(d, deps);
      expect(nextDelayMs).toBe(PACING.capacityMs);
      t += nextDelayMs!;
    }
    expect(fake.launches.map((l) => l.ad)).toEqual(["AD-1", "AD-2", "AD-3", "AD-1", "AD-2", "AD-3", "AD-1"]);
    expect(d.servers[0]).toMatchObject({ state: "waiting-capacity", attempts: 7 });
    fake.capacity.add("AD-2");
    await run(fake, d);
    expect(d.servers[0]).toMatchObject({ state: "running", availabilityDomain: "AD-2", attempts: 8 });
  });

  it("backs off exponentially on 429 and resets after progress", async () => {
    const fake = new FakeOci();
    fake.capacity = new Set(ADS);
    const d = fresh(plan({ action: "reuse", vcnId: "v", subnetId: "s", displayName: "n" }));
    d.servers = d.servers.slice(0, 1);
    fake.launchErrors = [1, 2, 3].map(() => ({ status: 429, code: "TooManyRequests", message: "Too many requests for the user" }));
    const { delays } = await run(fake, d);
    expect(delays.slice(0, 3)).toEqual([60_000, 120_000, 240_000]);
    expect(d.status).toBe("done");
    expect(d.backoffMs).toBe(PACING.backoffMinMs);
  });

  it("marks a server failed on LimitExceeded while the others continue", async () => {
    const fake = new FakeOci();
    fake.capacity = new Set(ADS);
    fake.launchErrors = [{ status: 400, code: "LimitExceeded", message: "The following service limits were exceeded: standard-a1-core-count" }];
    const d = fresh(plan({ action: "reuse", vcnId: "v", subnetId: "s", displayName: "n" }));
    await run(fake, d);
    expect(d.status).toBe("done");
    expect(d.servers.map((s) => s.state)).toEqual(["failed", "running", "running"]);
    expect(d.servers[0]!.message).toMatch(/no free allowance/);
  });

  it("adopts an instance from a lost launch response instead of launching twice", async () => {
    const fake = new FakeOci();
    fake.capacity = new Set(ADS);
    fake.instances.set("i-existing", { id: "i-existing", compartmentId: C, displayName: "easycloud-a1", availabilityDomain: "AD-3", lifecycleState: "PROVISIONING" });
    const d = fresh(plan({ action: "reuse", vcnId: "v", subnetId: "s", displayName: "n" }));
    d.servers = d.servers.slice(0, 1);
    await run(fake, d);
    expect(fake.launches).toEqual([]);
    expect(d.servers[0]).toMatchObject({ instanceId: "i-existing", availabilityDomain: "AD-3", state: "running" });
  });

  it("relaunches when Oracle terminates an accepted launch", async () => {
    const fake = new FakeOci();
    fake.capacity = new Set(ADS);
    fake.provisioningPolls = 2;
    const d = fresh(plan({ action: "reuse", vcnId: "v", subnetId: "s", displayName: "n" }));
    d.servers = d.servers.slice(0, 1);
    const deps = { client: await fakeClient(fake), now: () => new Date(), retrySeed: "acct" };
    await advance(d, deps); // launch accepted in AD-1
    fake.instances.get(d.servers[0]!.instanceId!)!.lifecycleState = "TERMINATED";
    await advance(d, deps); // sees TERMINATED
    expect(d.servers[0]).toMatchObject({ state: "waiting-capacity", instanceId: undefined, adIndex: 1 });
    await run(fake, d);
    expect(d.servers[0]).toMatchObject({ state: "running", availabilityDomain: "AD-2" });
  });

  it("fails the deployment when network setup hits a fatal error", async () => {
    const fake = new FakeOci();
    const d = fresh();
    const failing = { ...fake, handle: async () => Response.json({ code: "NotAuthorizedOrNotFound", message: "nope" }, { status: 404 }) } as unknown as FakeOci;
    await run(failing, d);
    expect(d.status).toBe("failed");
    expect(d.log.at(-1)!.message).toMatch(/Network setup failed/);
  });
});

describe("classify", () => {
  const e = (status: number, code: string, message = "") => new OciError(status, code, message, null);
  it("separates capacity, rate, transient and fatal errors", () => {
    expect(classify(e(500, "InternalError", "Out of host capacity."))).toBe("capacity");
    expect(classify(e(429, "TooManyRequests"))).toBe("rate");
    expect(classify(e(500, "InternalServerError", "boom"))).toBe("transient");
    expect(classify(e(503, "ServiceUnavailable"))).toBe("transient");
    expect(classify(e(409, "IncorrectState"))).toBe("transient");
    expect(classify(e(400, "LimitExceeded"))).toBe("fatal");
    expect(classify(e(404, "NotAuthorizedOrNotFound"))).toBe("fatal");
  });
});

describe("validSshPublicKey", () => {
  it("accepts OpenSSH public keys and rejects anything else", () => {
    expect(validSshPublicKey(SSH)).toBe(true);
    expect(validSshPublicKey("ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ== user@host")).toBe(true);
    expect(validSshPublicKey("ecdsa-sha2-nistp256 AAAAE2VjZHNh=")).toBe(true);
    expect(validSshPublicKey("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(false);
    expect(validSshPublicKey("ssh-ed25519")).toBe(false);
    expect(validSshPublicKey("ssh-ed25519 AAAA\nssh-rsa BBBB")).toBe(false);
  });
});
