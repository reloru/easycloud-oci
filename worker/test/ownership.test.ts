import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SETUPS_PER_DAY } from "../src/auth/store";
import worker from "../src/index";
import { signIn } from "./helpers/session";

const call = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://eazycloud.example${path}`, { ...init, headers }), env);
const create = async (headers: Record<string, string>) =>
  (await (await call("/api/accounts", headers, { method: "POST" })).json()) as { id: string };

describe("setup ownership", () => {
  it("requires a session for every API route", async () => {
    const alice = await signIn();
    const { id } = await create(alice.headers);
    const origin = { Origin: env.ORIGIN };
    expect((await call("/api/setups")).status).toBe(401);
    expect((await call("/api/accounts", origin, { method: "POST" })).status).toBe(401);
    expect((await call(`/api/accounts/${id}`)).status).toBe(401);
    expect((await call(`/api/accounts/${id}/plan`)).status).toBe(401);
  });

  it("hides one user's setup from another user, as if it did not exist", async () => {
    const alice = await signIn();
    const bob = await signIn();
    const { id } = await create(alice.headers);
    expect((await call(`/api/accounts/${id}`, alice.headers)).status).toBe(200);
    for (const path of [`/api/accounts/${id}`, `/api/accounts/${id}/plan`, `/api/accounts/${id}/deployment`, `/api/accounts/${id}/control-sheet`]) {
      expect((await call(path, bob.headers)).status).toBe(404);
    }
    const connect = await call(`/api/accounts/${id}/connect`, bob.headers, { method: "POST", body: JSON.stringify({ preview: "x" }) });
    expect(connect.status).toBe(404);
    const cancel = await call(`/api/accounts/${id}/cancel`, bob.headers, { method: "POST" });
    expect(cancel.status).toBe(404);
  });

  it("lists only the signed-in user's setups, newest first", async () => {
    const alice = await signIn();
    const bob = await signIn();
    const a1 = await create(alice.headers);
    await create(bob.headers);
    const a2 = await create(alice.headers);
    const res = await call("/api/setups", alice.headers);
    const { setups } = (await res.json()) as { setups: { id: string }[] };
    expect(setups.map((s) => s.id).sort()).toEqual([a1.id, a2.id].sort());
  });

  it("rejects state-changing API calls from another origin", async () => {
    const alice = await signIn();
    const res = await call("/api/accounts", { ...alice.headers, Origin: "https://evil.example" }, { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("limits how many setups one user can start per day", async () => {
    const alice = await signIn();
    for (let i = 0; i < SETUPS_PER_DAY; i++) expect((await call("/api/accounts", alice.headers, { method: "POST" })).status).toBe(201);
    const res = await call("/api/accounts", alice.headers, { method: "POST" });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "too-many-setups" });
  });

  it("redirects other hosts to the canonical origin", async () => {
    const res = await worker.fetch(new Request("https://easycloud.reloru.workers.dev/api/setups?x=1"), env);
    expect(res.status).toBe(308);
    expect(res.headers.get("Location")).toBe(`${env.ORIGIN}/api/setups?x=1`);
  });
});
