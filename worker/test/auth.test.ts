import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authStub, handleAuth, SESSION_COOKIE, type OutgoingEmail } from "../src/auth/routes";
import { CODE_MAX_PER_HOUR, CODE_RESEND_MS, CODE_TTL_MS } from "../src/auth/store";

const ORIGIN = env.ORIGIN;
let seq = 0;
const freshEmail = () => `person${Date.now()}-${++seq}@example.com`;

function harness() {
  const sent: OutgoingEmail[] = [];
  let now = Date.UTC(2026, 9, 12, 12, 0, 0);
  let failSend = false;
  const deps = {
    send: async (m: OutgoingEmail) => {
      if (failSend) throw Object.assign(new Error("boom"), { code: "E_RATE_LIMIT_EXCEEDED" });
      sent.push(m);
    },
    now: () => now,
  };
  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const init: RequestInit = body === undefined
      ? { method: "GET", headers }
      : { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) };
    return (await handleAuth(new Request(`https://eazycloud.test${path}`, init), env, deps))!;
  };
  const lastCode = () => /(\d{6})/.exec(sent.at(-1)!.text)![1]!;
  return {
    sent, call, lastCode, deps,
    advance: (ms: number) => { now += ms; },
    failSending: (v: boolean) => { failSend = v; },
  };
}

const cookieFrom = (res: Response) => res.headers.get("Set-Cookie") ?? "";
const tokenFrom = (res: Response) => new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(cookieFrom(res))![1]!;

afterEach(() => vi.restoreAllMocks());

describe("email code sign-in", () => {
  it("sends a code, signs in with it, and the session cookie identifies the user", async () => {
    const h = harness();
    const email = freshEmail();
    const start = await h.call("/auth/email/start", { email: `  ${email.toUpperCase()} ` });
    expect(start.status).toBe(200);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ to: email, from: env.EMAIL_FROM });
    expect(h.sent[0]!.subject).toContain(h.lastCode());

    const verify = await h.call("/auth/email/verify", { email, code: h.lastCode() });
    expect(verify.status).toBe(200);
    expect(await verify.json()).toEqual({ user: { email } });
    const cookie = cookieFrom(verify);
    for (const flag of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax", "Max-Age=2592000"]) expect(cookie).toContain(flag);
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);

    const me = await h.call("/auth/me", undefined, { Cookie: `${SESSION_COOKIE}=${tokenFrom(verify)}` });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ user: { email } });
  });

  it("a code works once", async () => {
    const h = harness();
    const email = freshEmail();
    await h.call("/auth/email/start", { email });
    const code = h.lastCode();
    expect((await h.call("/auth/email/verify", { email, code })).status).toBe(200);
    expect((await h.call("/auth/email/verify", { email, code })).status).toBe(410);
  });

  it("signing in again with the same email reaches the same user", async () => {
    const h = harness();
    const email = freshEmail();
    await h.call("/auth/email/start", { email });
    await h.call("/auth/email/verify", { email, code: h.lastCode() });
    h.advance(CODE_RESEND_MS + 1);
    await h.call("/auth/email/start", { email });
    const again = await h.call("/auth/email/verify", { email, code: h.lastCode() });
    expect(await again.json()).toEqual({ user: { email } });
  });

  it("locks the code after 5 wrong tries, even for the right code", async () => {
    const h = harness();
    const email = freshEmail();
    await h.call("/auth/email/start", { email });
    const right = h.lastCode();
    const wrong = right === "000000" ? "111111" : "000000";
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await h.call("/auth/email/verify", { email, code: wrong })).status);
    expect(statuses).toEqual([400, 400, 400, 400, 410]);
    const after = await h.call("/auth/email/verify", { email, code: right });
    expect(after.status).toBe(410);
    expect(await after.json()).toMatchObject({ error: "too-many-attempts" });
  });

  it("expires codes after 10 minutes", async () => {
    const h = harness();
    const email = freshEmail();
    await h.call("/auth/email/start", { email });
    h.advance(CODE_TTL_MS + 1);
    const res = await h.call("/auth/email/verify", { email, code: h.lastCode() });
    expect(await res.json()).toMatchObject({ error: "expired" });
  });

  it("enforces a resend gap", async () => {
    const h = harness();
    const email = freshEmail();
    expect((await h.call("/auth/email/start", { email })).status).toBe(200);
    expect((await h.call("/auth/email/start", { email })).status).toBe(429);
    h.advance(CODE_RESEND_MS + 1);
    expect((await h.call("/auth/email/start", { email })).status).toBe(200);
    expect(h.sent).toHaveLength(2);
  });

  it("caps codes per email per hour", async () => {
    const stub = authStub(env);
    const email = freshEmail();
    let t = Date.UTC(2026, 9, 12, 12, 0, 0);
    for (let i = 0; i < CODE_MAX_PER_HOUR; i++, t += CODE_RESEND_MS + 1) expect(await stub.startEmail(email, "h", t)).toEqual({ ok: true });
    expect(await stub.startEmail(email, "h", t)).toEqual({ ok: false, error: "too-many" });
    expect(await stub.startEmail(email, "h", t + 3600_000)).toEqual({ ok: true });
  });

  it("answers the same for new and existing emails", async () => {
    const h = harness();
    const existing = freshEmail();
    await h.call("/auth/email/start", { email: existing });
    await h.call("/auth/email/verify", { email: existing, code: h.lastCode() });
    h.advance(CODE_RESEND_MS + 1);
    const a = await h.call("/auth/email/start", { email: existing });
    const b = await h.call("/auth/email/start", { email: freshEmail() });
    expect([a.status, await a.text()]).toEqual([b.status, await b.text()]);
  });

  it("rejects bad input", async () => {
    const h = harness();
    expect((await h.call("/auth/email/start", { email: "not-an-email" })).status).toBe(400);
    expect((await h.call("/auth/email/verify", { email: freshEmail(), code: "12ab56" })).status).toBe(400);
    expect(h.sent).toHaveLength(0);
  });

  it("reports a send failure without leaking details", async () => {
    const h = harness();
    h.failSending(true);
    const res = await h.call("/auth/email/start", { email: freshEmail() });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "send-failed" });
  });

  it("never logs codes, emails or tokens", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const h = harness();
    const email = freshEmail();
    await h.call("/auth/email/start", { email });
    const code = h.lastCode();
    const verify = await h.call("/auth/email/verify", { email, code });
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of [code, email, tokenFrom(verify)]) for (const line of lines) expect(line).not.toContain(secret);
  });
});

describe("sessions and origin checks", () => {
  async function signedIn() {
    const h = harness();
    const email = freshEmail();
    await h.call("/auth/email/start", { email });
    const verify = await h.call("/auth/email/verify", { email, code: h.lastCode() });
    return { h, email, cookie: `${SESSION_COOKIE}=${tokenFrom(verify)}` };
  }

  it("rejects state-changing requests from another origin or with no origin", async () => {
    const h = harness();
    const req = (origin?: string) =>
      new Request("https://eazycloud.test/auth/email/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
        body: JSON.stringify({ email: freshEmail() }),
      });
    expect((await handleAuth(req("https://evil.example"), env, h.deps))!.status).toBe(403);
    expect((await handleAuth(req(), env, h.deps))!.status).toBe(403);
    expect(h.sent).toHaveLength(0);
  });

  it("signs out", async () => {
    const { h, cookie } = await signedIn();
    const out = await h.call("/auth/logout", {}, { Cookie: cookie });
    expect(cookieFrom(out)).toContain("Max-Age=0");
    expect((await h.call("/auth/me", undefined, { Cookie: cookie })).status).toBe(401);
  });

  it("expires sessions after 30 days and renews them when used in the second half", async () => {
    const { h, cookie } = await signedIn();
    h.advance(20 * 24 * 3600_000);
    const renewed = await h.call("/auth/me", undefined, { Cookie: cookie });
    expect(renewed.status).toBe(200);
    expect(cookieFrom(renewed)).toContain("Max-Age=2592000");
    h.advance(29 * 24 * 3600_000);
    expect((await h.call("/auth/me", undefined, { Cookie: cookie })).status).toBe(200);
    h.advance(31 * 24 * 3600_000);
    expect((await h.call("/auth/me", undefined, { Cookie: cookie })).status).toBe(401);
  });

  it("ignores unknown or missing session tokens", async () => {
    const h = harness();
    expect((await h.call("/auth/me")).status).toBe(401);
    expect((await h.call("/auth/me", undefined, { Cookie: `${SESSION_COOKIE}=nope` })).status).toBe(401);
  });

  it("leaves non-auth paths to the rest of the router", async () => {
    const h = harness();
    expect(await handleAuth(new Request("https://eazycloud.test/api/accounts"), env, h.deps)).toBeNull();
  });
});
