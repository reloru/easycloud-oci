import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const call = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://easycloud.example${path}`, init), env);

describe("onboarding routes", () => {
  it("creates an account and returns the public key to paste into the Console", async () => {
    const res = await call("/api/accounts", { method: "POST" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, string>;
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.state).toBe("awaiting-key");
    expect(body.publicPem).toContain("BEGIN PUBLIC KEY");
    expect(body.fingerprint).toMatch(/^(?:[0-9a-f]{2}:){15}[0-9a-f]{2}$/);
    expect(body).not.toHaveProperty("sealedKey");

    const status = await call(`/api/accounts/${body.id}`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ id: body.id, fingerprint: body.fingerprint });
  });

  it("404s unknown or malformed account ids", async () => {
    expect((await call("/api/accounts/AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
    expect((await call("/api/accounts/not-an-id")).status).toBe(404);
  });

  it("validates the connect request body", async () => {
    const { id } = (await (await call("/api/accounts", { method: "POST" })).json()) as { id: string };
    expect((await call(`/api/accounts/${id}/connect`, { method: "POST", body: "{" })).status).toBe(400);
    expect((await call(`/api/accounts/${id}/connect`, { method: "POST", body: "{}" })).status).toBe(400);
    expect((await call(`/api/accounts/${id}/connect`, { method: "POST", body: JSON.stringify({ preview: "x".repeat(5000) }) })).status).toBe(413);

    const res = await call(`/api/accounts/${id}/connect`, { method: "POST", body: JSON.stringify({ preview: "region=us-ashburn-1" }) });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ ok: false, error: { kind: "invalid-preview" } });
  });
});
