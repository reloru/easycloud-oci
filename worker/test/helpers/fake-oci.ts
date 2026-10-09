/** Stateful in-memory stand-in for the OCI core API (networking + compute), for unit tests. */
import { OciClient } from "../../src/oci/client";
import { importPrivateKeyPem } from "../../src/oci/signer";
import ref from "../fixtures/signer-reference.json";

export type Obj = Record<string, any>;
type Injected = { status: number; code: string; message: string };

export class FakeOci {
  vcns = new Map<string, Obj>();
  igws = new Map<string, Obj>();
  routeTables = new Map<string, Obj>();
  securityLists = new Map<string, Obj>();
  subnets = new Map<string, Obj>();
  instances = new Map<string, Obj>();
  vnicAttachments = new Map<string, Obj>();
  vnics = new Map<string, Obj>();
  tokens = new Map<string, Obj>();
  calls: string[] = [];
  launches: { ad: string; body: Obj; token: string | null }[] = [];
  /** Errors returned (in order) by the next POST /instances calls. */
  launchErrors: Injected[] = [];
  /** ADs with capacity; launches elsewhere fail with "Out of host capacity." */
  capacity = new Set<string>();
  /** GETs an instance needs before it reports RUNNING. */
  provisioningPolls = 1;
  private n = 0;

  constructor(private readonly defaultSsh = false) {}

  private id(kind: string) {
    return `ocid1.${kind}.oc1..${++this.n}`;
  }

  private store(kind: string): Map<string, Obj> | undefined {
    return ({
      vcns: this.vcns,
      internetGateways: this.igws,
      routeTables: this.routeTables,
      securityLists: this.securityLists,
      subnets: this.subnets,
      instances: this.instances,
      vnicAttachments: this.vnicAttachments,
      vnics: this.vnics,
    } as Record<string, Map<string, Obj>>)[kind];
  }

  handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const [, , kind, id] = url.pathname.split("/");
    this.calls.push(`${req.method} ${kind}${id ? "/:id" : ""}`);
    const store = this.store(kind!);
    if (!store) return Response.json({ code: "NotFound", message: url.pathname }, { status: 404 });
    const q = url.searchParams;

    if (req.method === "GET" && !id) {
      return Response.json(
        [...store.values()].filter(
          (r) =>
            (!q.get("compartmentId") || r.compartmentId === q.get("compartmentId")) &&
            (!q.get("vcnId") || r.vcnId === q.get("vcnId")) &&
            (!q.get("instanceId") || r.instanceId === q.get("instanceId")) &&
            (!q.get("displayName") || r.displayName === q.get("displayName")),
        ),
      );
    }
    if (req.method === "GET") {
      const r = store.get(id!);
      if (!r) return Response.json({ code: "NotAuthorizedOrNotFound", message: id }, { status: 404 });
      if (kind === "instances" && r.lifecycleState === "PROVISIONING") {
        r._polls = (r._polls ?? 0) + 1;
        if (r._polls >= this.provisioningPolls) this.boot(r);
      } else if (r.lifecycleState === "PROVISIONING") {
        r.lifecycleState = "AVAILABLE";
      }
      return Response.json(r);
    }
    if (req.method === "PUT") {
      const r = store.get(id!)!;
      Object.assign(r, await req.json());
      return Response.json(r);
    }
    if (req.method === "POST") {
      const token = req.headers.get("opc-retry-token");
      if (token && this.tokens.has(token)) return Response.json(this.tokens.get(token));
      const body = (await req.json()) as Obj;
      if (kind === "instances") {
        this.launches.push({ ad: body.availabilityDomain, body, token });
        const injected = this.launchErrors.shift();
        if (injected) return Response.json({ code: injected.code, message: injected.message }, { status: injected.status });
        if (!this.capacity.has(body.availabilityDomain)) {
          return Response.json({ code: "InternalError", message: "Out of host capacity." }, { status: 500 });
        }
      }
      const r: Obj = { ...body, id: this.id(kind!), lifecycleState: "PROVISIONING" };
      if (kind === "vcns") {
        const rt = { id: this.id("routetable"), compartmentId: body.compartmentId, vcnId: r.id, routeRules: [] };
        const sl = {
          id: this.id("securitylist"),
          compartmentId: body.compartmentId,
          vcnId: r.id,
          ingressSecurityRules: this.defaultSsh
            ? [{ protocol: "6", source: "0.0.0.0/0", tcpOptions: { destinationPortRange: { min: 22, max: 22 } } }]
            : [{ protocol: "1", source: "0.0.0.0/0" }],
        };
        this.routeTables.set(rt.id, rt);
        this.securityLists.set(sl.id, sl);
        Object.assign(r, { defaultRouteTableId: rt.id, defaultSecurityListId: sl.id });
      }
      store.set(r.id, r);
      if (token) this.tokens.set(token, r);
      return Response.json(r);
    }
    return new Response("unsupported", { status: 500 });
  };

  private boot(instance: Obj) {
    instance.lifecycleState = "RUNNING";
    const vnic = { id: this.id("vnic"), publicIp: `203.0.113.${this.n}`, lifecycleState: "AVAILABLE" };
    this.vnics.set(vnic.id, vnic);
    const att = { id: this.id("vnicattachment"), compartmentId: instance.compartmentId, instanceId: instance.id, vnicId: vnic.id, lifecycleState: "ATTACHED" };
    this.vnicAttachments.set(att.id, att);
  }
}

export async function fakeClient(fake: FakeOci): Promise<OciClient> {
  const privateKey = await importPrivateKeyPem(ref.privateKeyPem);
  return new OciClient({ tenancyOcid: "t", userOcid: "u", fingerprint: ref.fingerprint, privateKey }, fake.handle);
}
