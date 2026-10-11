import type { Env as AppEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      OCI_KEY_B64?: string;
      OCI_USER?: string;
      OCI_TENANCY?: string;
      OCI_REGION?: string;
    }
  }
}
