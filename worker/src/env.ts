import type { Account } from "./account";

export interface Env {
  ACCOUNTS: DurableObjectNamespace<Account>;
  /** base64 of 32 random bytes; encrypts stored OCI private keys (wrangler secret). */
  KEY_ENCRYPTION_KEY: string;
}
