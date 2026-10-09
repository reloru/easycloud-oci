import { describe, expect, it } from "vitest";
import { importDataKey } from "../src/crypto/envelope";
import { connectAccount, createAccount, getAccount, type OnboardingDeps } from "../src/onboarding";

const USER = "ocid1.user.oc1..aaaaaaaauser";
const TENANCY = "ocid1.tenancy.oc1..aaaaaaaatenancy";

function memoryStorage() {
  const map = new Map<string, unknown>();
  return {
    map,
    async get<T>(key: string) {
      return structuredClone(map.get(key)) as T | undefined;
    },
    async put<T>(key: string, value: T) {
      map.set(key, structuredClone(value));
    },
  };
}

type Handler = (req: Request) => Response | Promise<Response>;

async function setup(handler: Handler) {
  const seen: Request[] = [];
  const deps: OnboardingDeps = {
    storage: memoryStorage(),
    dataKey: await importDataKey("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="),
    accountId: "test-account-id-000000",
    fetchImpl: async (req) => {
      seen.push(req.clone());
      return handler(req);
    },
    now: () => new Date(Date.UTC(2026, 9, 9, 12, 0, 0)),
  };
  const account = await createAccount(deps);
  const preview = (region: string, fingerprint = account.fingerprint) =>
    `[DEFAULT]\nuser=${USER}\nfingerprint=${fingerprint}\ntenancy=${TENANCY}\nregion=${region}\nkey_file=<path> # TODO`;
  return { deps, account, preview, seen };
}

const ok = (body: unknown) => Response.json(body);
const ociError = (status: number, code: string, message: string) =>
  Response.json({ code, message }, { status, headers: { "opc-request-id": "req-123" } });

describe("createAccount", () => {
  it("is idempotent and never exposes the sealed key", async () => {
    const { deps, account } = await setup(() => ok([]));
    expect(account.state).toBe("awaiting-key");
    expect(account).not.toHaveProperty("sealedKey");
    expect(await createAccount(deps)).toEqual(account);
    expect(await getAccount(deps)).toEqual(account);
  });
});

describe("connectAccount", () => {
  it("resolves the home region from subscriptions (not the preview region) and lists its ADs", async () => {
    const { deps, preview, seen, account } = await setup((req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/regionSubscriptions")) {
        return ok([
          { regionKey: "PHX", regionName: "us-phoenix-1", status: "READY", isHomeRegion: false },
          { regionKey: "IAD", regionName: "us-ashburn-1", status: "READY", isHomeRegion: true },
        ]);
      }
      if (url.pathname === "/20160918/availabilityDomains") {
        return ok(["AD-1", "AD-2", "AD-3"].map((n) => ({ name: `Uocm:US-ASHBURN-${n}`, id: n, compartmentId: TENANCY })));
      }
      return new Response("unexpected", { status: 500 });
    });

    const result = await connectAccount(deps, preview("us-phoenix-1"));
    expect(result).toMatchObject({
      ok: true,
      account: {
        state: "connected",
        homeRegion: "us-ashburn-1",
        tenancy: TENANCY,
        user: USER,
        availabilityDomains: ["Uocm:US-ASHBURN-AD-1", "Uocm:US-ASHBURN-AD-2", "Uocm:US-ASHBURN-AD-3"],
      },
    });
    expect(seen.map((r) => r.url)).toEqual([
      `https://identity.us-phoenix-1.oraclecloud.com/20160918/tenancies/${TENANCY}/regionSubscriptions`,
      `https://identity.us-ashburn-1.oraclecloud.com/20160918/availabilityDomains?compartmentId=${TENANCY}`,
    ]);
    for (const req of seen) {
      expect(req.headers.get("authorization")).toContain(`keyId="${TENANCY}/${USER}/${account.fingerprint}"`);
      expect(req.headers.get("date")).toBe("Fri, 09 Oct 2026 12:00:00 GMT");
    }
    expect(await getAccount(deps)).toMatchObject({ state: "connected", homeRegion: "us-ashburn-1" });
  });

  it("rejects a preview for a different key without calling Oracle", async () => {
    const { deps, preview, seen } = await setup(() => ok([]));
    const result = await connectAccount(deps, preview("us-ashburn-1", "00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff"));
    expect(result).toMatchObject({ ok: false, error: { kind: "fingerprint-mismatch" } });
    expect(seen).toHaveLength(0);
  });

  it("rejects an incomplete preview with field-level details", async () => {
    const { deps, seen } = await setup(() => ok([]));
    const result = await connectAccount(deps, "region=us-ashburn-1");
    expect(result).toMatchObject({ ok: false, error: { kind: "invalid-preview" } });
    expect(result.ok === false && result.error.kind === "invalid-preview" && result.error.details.length).toBe(3);
    expect(seen).toHaveLength(0);
  });

  it.each([
    [401, "NotAuthenticated", "not-authenticated"],
    [404, "NotAuthorizedOrNotFound", "not-authorized"],
    [500, "InternalError", "oci-error"],
  ] as const)("maps OCI %i %s to %s and keeps the opc-request-id", async (status, code, kind) => {
    const { deps, preview } = await setup(() => ociError(status, code, "nope"));
    const result = await connectAccount(deps, preview("us-ashburn-1"));
    expect(result).toMatchObject({ ok: false, error: { kind, opcRequestId: "req-123" } });
    expect(await getAccount(deps)).toMatchObject({ state: "awaiting-key" });
  });

  it("reports an unknown account", async () => {
    const { deps, preview } = await setup(() => ok([]));
    const empty = { ...deps, storage: memoryStorage() };
    expect(await connectAccount(empty, preview("us-ashburn-1"))).toMatchObject({ ok: false, error: { kind: "unknown-account" } });
  });
});
