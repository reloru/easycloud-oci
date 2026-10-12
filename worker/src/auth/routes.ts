/**
 * Sign-in routes: emailed one-time code, session cookie, sign-out.
 * Responses never reveal whether an email already has an account.
 */
import type { Env } from "../env";
import { codeHash, codeKey, randomToken, sha256Hex, sixDigitCode } from "./crypto";
import { SESSION_TTL_MS, type SessionUser } from "./store";

export const SESSION_COOKIE = "__Host-eazy";
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const CODE = /^\d{6}$/;
const MAX_BODY_BYTES = 1024;

export interface OutgoingEmail {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

export interface AuthDeps {
  send: (message: OutgoingEmail) => Promise<unknown>;
  now: () => number;
}

export const defaultAuthDeps = (env: Env): AuthDeps => ({
  send: (m) => env.EMAIL.send(m),
  now: () => Date.now(),
});

const json = (body: unknown, status = 200, headers?: HeadersInit) => Response.json(body, { status, headers });

export function authStub(env: Env) {
  return env.AUTH.get(env.AUTH.idFromName("global"));
}

/** State-changing requests must come from the app's own origin (CSRF defense alongside SameSite=Lax). */
export function sameOrigin(request: Request, env: Env): boolean {
  return request.headers.get("Origin") === env.ORIGIN;
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

export function sessionCookie(token: string, maxAgeMs = SESSION_TTL_MS): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

export function readSessionToken(request: Request): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=") || null;
  }
  return null;
}

/** The signed-in user for this request, or null. */
export async function currentUser(request: Request, env: Env, now = Date.now()): Promise<(SessionUser & { token: string }) | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const user = await authStub(env).sessionUser(await sha256Hex(token), now);
  return user && { ...user, token };
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function codeEmail(to: string, from: string, code: string): OutgoingEmail {
  const text = `Your EazyCloud sign-in code is ${code}\n\nIt works for 10 minutes. If you didn't ask for it, ignore this email.`;
  const html = `<p>Your EazyCloud sign-in code is</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p><p>It works for 10 minutes. If you didn't ask for it, ignore this email.</p>`;
  return { to, from, subject: `EazyCloud sign-in code: ${code}`, text, html };
}

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ event: "auth", ...fields }));

/** Handles /auth/* routes; returns null for any other path. */
export async function handleAuth(request: Request, env: Env, deps: AuthDeps = defaultAuthDeps(env)): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/auth/")) return null;

  if (pathname === "/auth/me" && request.method === "GET") {
    const user = await currentUser(request, env, deps.now());
    if (!user) return json({ error: "signed-out" }, 401);
    const headers = user.renewedUntil ? { "Set-Cookie": sessionCookie(user.token) } : undefined;
    return json({ user: { email: user.email } }, 200, headers);
  }

  if (request.method !== "POST") return json({ error: "not-found" }, 404);
  if (!sameOrigin(request, env)) return json({ error: "bad-origin" }, 403);

  if (pathname === "/auth/email/start") {
    const body = await readJson(request);
    const email = normalizeEmail(body?.email);
    if (!email) return json({ error: "invalid-email", message: "Enter a valid email address." }, 400);
    const limited = await env.AUTH_SEND_LIMIT.limit({ key: email });
    if (!limited.success) return json({ error: "slow-down", message: "Please wait a minute before asking for another code." }, 429);
    const code = sixDigitCode();
    const key = await codeKey(env.KEY_ENCRYPTION_KEY);
    const started = await authStub(env).startEmail(email, await codeHash(key, email, code), deps.now());
    if (!started.ok) {
      log({ step: "start", ok: false, kind: started.error });
      const message = started.error === "too-soon" ? "Please wait a minute before asking for another code." : "Too many codes requested. Try again in an hour.";
      return json({ error: "slow-down", message }, 429);
    }
    try {
      await deps.send(codeEmail(email, env.EMAIL_FROM, code));
    } catch (err) {
      log({ step: "send", ok: false, code: (err as { code?: string }).code ?? "unknown" });
      return json({ error: "send-failed", message: "We couldn't send the email right now. Try again in a few minutes." }, 503);
    }
    log({ step: "start", ok: true });
    return json({ ok: true });
  }

  if (pathname === "/auth/email/verify") {
    const body = await readJson(request);
    const email = normalizeEmail(body?.email);
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    if (!email || !CODE.test(code)) return json({ error: "invalid-code", message: "Enter the 6-digit code from the email." }, 400);
    const key = await codeKey(env.KEY_ENCRYPTION_KEY);
    const token = randomToken();
    const result = await authStub(env).verifyEmail(email, await codeHash(key, email, code), await sha256Hex(token), deps.now());
    log({ step: "verify", ok: result.ok, ...(result.ok ? {} : { kind: result.error }) });
    if (!result.ok) {
      const message = {
        "invalid-code": "That code isn't right. Check the email and try again.",
        expired: "That code has expired. Ask for a new one.",
        "too-many-attempts": "Too many wrong tries. Ask for a new code.",
      }[result.error];
      return json({ error: result.error, message }, result.error === "invalid-code" ? 400 : 410);
    }
    return json({ user: { email: result.user.email } }, 200, { "Set-Cookie": sessionCookie(token) });
  }

  if (pathname === "/auth/logout") {
    const token = readSessionToken(request);
    if (token) await authStub(env).endSession(await sha256Hex(token));
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }

  return json({ error: "not-found" }, 404);
}
