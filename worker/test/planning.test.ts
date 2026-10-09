import { describe, expect, it } from "vitest";
import { importDataKey } from "../src/crypto/envelope";
import { connectAccount, createAccount, type OnboardingDeps } from "../src/onboarding";
import { planAccount } from "../src/planning";

const T = "ocid1.tenancy.oc1..aaaatenancy";
const U = "ocid1.user.oc1..aaaauser";

function memoryStorage() {
  const map = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return structuredClone(map.get(key)) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      map.set(key, structuredClone(value));
    },
  };
}

function fakeOci(methods: string[]) {
  return async (req: Request) => {
    methods.push(req.method);
    const { pathname } = new URL(req.url);
    if (pathname.endsWith("/regionSubscriptions")) return Response.json([{ regionKey: "IAD", regionName: "us-ashburn-1", status: "READY", isHomeRegion: true }]);
    if (pathname.endsWith("/availabilityDomains")) return Response.json([{ name: "AD-1", id: "a", compartmentId: T }]);
    if (pathname.endsWith("/images")) {
      const shape = new URL(req.url).searchParams.get("shape");
      return Response.json([{ id: `img-${shape}`, displayName: "x", operatingSystemVersion: shape?.includes("A1") ? "24.04 Minimal aarch64" : "24.04 Minimal" }]);
    }
    if (pathname.endsWith("/limitValues")) return Response.json([]);
    return Response.json([]); // compartments, instances, volumes, vcns: empty account
  };
}

async function connected(methods: string[]) {
  const deps: OnboardingDeps = {
    storage: memoryStorage(),
    dataKey: await importDataKey("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="),
    accountId: "acct",
    fetchImpl: fakeOci(methods),
  };
  const account = await createAccount(deps);
  const preview = `user=${U}\nfingerprint=${account.fingerprint}\ntenancy=${T}\nregion=us-ashburn-1`;
  expect((await connectAccount(deps, preview)).ok).toBe(true);
  return deps;
}

describe("planAccount", () => {
  it("refuses before the account is connected", async () => {
    const deps: OnboardingDeps = {
      storage: memoryStorage(),
      dataKey: await importDataKey("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="),
      accountId: "acct",
    };
    await createAccount(deps);
    expect(await planAccount(deps)).toMatchObject({ ok: false, error: { kind: "not-connected" } });
  });

  it("plans the full free layout for an empty account using only GET requests", async () => {
    const methods: string[] = [];
    const deps = await connected(methods);
    const result = await planAccount(deps);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.create.map((c) => [c.role, c.bootVolumeGB, c.image?.id])).toEqual([
      ["a1", 106, "img-VM.Standard.A1.Flex"],
      ["micro", 47, "img-VM.Standard.E2.1.Micro"],
      ["micro", 47, "img-VM.Standard.E2.1.Micro"],
    ]);
    expect(result.plan.network).toEqual({ action: "create" });
    expect(new Set(methods)).toEqual(new Set(["GET"]));
  });
});
