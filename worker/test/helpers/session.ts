import { env } from "cloudflare:test";
import { randomToken, sha256Hex } from "../../src/auth/crypto";
import { authStub, SESSION_COOKIE } from "../../src/auth/routes";

let n = 0;

/** Signs a fresh user in through the Auth object and returns headers that act as that user. */
export async function signIn(email = `user${Date.now()}-${++n}@example.com`) {
  const stub = authStub(env);
  const now = Date.now();
  await stub.startEmail(email, "test-hash", now);
  const token = randomToken();
  const result = await stub.verifyEmail(email, "test-hash", await sha256Hex(token), now);
  if (!result.ok) throw new Error(`sign-in failed: ${result.error}`);
  return { email, userId: result.user.id, headers: { Cookie: `${SESSION_COOKIE}=${token}`, Origin: env.ORIGIN } };
}
