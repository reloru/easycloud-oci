import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Account } from "../src/account";
import { RESET_MIN_AGE_MS } from "../src/auth/store";
import worker from "../src/index";
import { signIn } from "./helpers/session";

const call = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://eazycloud.example${path}`, { ...init, headers }), env);
const create = async (headers: Record<string, string>) =>
  (await (await call("/api/accounts", headers, { method: "POST" })).json()) as { id: string; fingerprint: string };

/** Age the user's setup row so start-over is allowed without waiting a real minute. */
async function ageSetup(id: string) {
  const auth = env.AUTH.get(env.AUTH.idFromName("global"));
  await runInDurableObject(auth, async (_i, state: DurableObjectState) => {
    state.storage.sql.exec("UPDATE setups SET created_at = created_at - ? WHERE account_id = ?", RESET_MIN_AGE_MS + 1, id);
  });
}

describe("one Oracle account per user", () => {
  it("requires a session for every API route", async () => {
    const alice = await signIn();
    const { id } = await create(alice.headers);
    const origin = { Origin: env.ORIGIN };
    expect((await call("/api/me/account")).status).toBe(401);
    expect((await call("/api/accounts", origin, { method: "POST" })).status).toBe(401);
    expect((await call(`/api/accounts/${id}`)).status).toBe(401);
    expect((await call(`/api/accounts/${id}/plan`)).status).toBe(401);
  });

  it("gives each user exactly one account and returns it again instead of making a second", async () => {
    const alice = await signIn();
    expect((await call("/api/me/account", alice.headers)).status).toBe(404);
    const first = await call("/api/accounts", alice.headers, { method: "POST" });
    expect(first.status).toBe(201);
    const a = (await first.json()) as { id: string; fingerprint: string };
    const again = await call("/api/accounts", alice.headers, { method: "POST" });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id: a.id, fingerprint: a.fingerprint });
    expect(await (await call("/api/me/account", alice.headers)).json()).toEqual({ id: a.id });
  });

  it("hides one user's account from another user, as if it did not exist", async () => {
    const alice = await signIn();
    const bob = await signIn();
    const { id } = await create(alice.headers);
    expect((await call(`/api/accounts/${id}`, alice.headers)).status).toBe(200);
    for (const path of [`/api/accounts/${id}`, `/api/accounts/${id}/plan`, `/api/accounts/${id}/deployment`, `/api/accounts/${id}/control-sheet`]) {
      expect((await call(path, bob.headers)).status).toBe(404);
    }
    for (const verb of ["connect", "cancel", "reset"]) {
      expect((await call(`/api/accounts/${id}/${verb}`, bob.headers, { method: "POST", body: JSON.stringify({ preview: "x" }) })).status).toBe(404);
    }
    expect((await call("/api/me/account", bob.headers)).status).toBe(404);
  });

  it("starts over with a new key, and the old link stops working", async () => {
    const alice = await signIn();
    const old = await create(alice.headers);
    expect((await call(`/api/accounts/${old.id}/reset`, alice.headers, { method: "POST" })).status).toBe(429);
    await ageSetup(old.id);
    const res = await call(`/api/accounts/${old.id}/reset`, alice.headers, { method: "POST" });
    expect(res.status).toBe(201);
    const fresh = (await res.json()) as { id: string; fingerprint: string; state: string };
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.fingerprint).not.toBe(old.fingerprint);
    expect(fresh.state).toBe("awaiting-key");
    expect(await (await call("/api/me/account", alice.headers)).json()).toEqual({ id: fresh.id });
    expect((await call(`/api/accounts/${old.id}`, alice.headers)).status).toBe(404);
  });

  it("refuses to start over while servers are being set up", async () => {
    const alice = await signIn();
    const { id } = await create(alice.headers);
    await ageSetup(id);
    await runInDurableObject(env.ACCOUNTS.getByName(id), async (_i: Account, state: DurableObjectState) => {
      await state.storage.put("deployment", { status: "servers", servers: [], log: [] });
    });
    const res = await call(`/api/accounts/${id}/reset`, alice.headers, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "busy" });
  });

  it("rejects state-changing API calls from another origin", async () => {
    const alice = await signIn();
    const res = await call("/api/accounts", { ...alice.headers, Origin: "https://evil.example" }, { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("redirects other hosts to the canonical origin", async () => {
    const res = await worker.fetch(new Request("https://easycloud.reloru.workers.dev/api/me/account?x=1"), env);
    expect(res.status).toBe(308);
    expect(res.headers.get("Location")).toBe(`${env.ORIGIN}/api/me/account?x=1`);
  });
});
