import type { Account } from "./account";
import type { Auth } from "./auth/store";

export interface Env {
  ACCOUNTS: DurableObjectNamespace<Account>;
  AUTH: DurableObjectNamespace<Auth>;
  /** base64 of 32 random bytes; encrypts stored OCI private keys and keys the sign-in code HMAC (wrangler secret). */
  KEY_ENCRYPTION_KEY: string;
  EMAIL: SendEmail;
  /** Coarse per-email throttle on sign-in code sends. */
  AUTH_SEND_LIMIT: RateLimit;
  /** Canonical origin, e.g. https://eazycloud.app. State-changing requests must carry it as Origin. */
  ORIGIN: string;
  /** WebAuthn relying-party id (the bare domain). */
  RP_ID: string;
  EMAIL_FROM: string;
}
