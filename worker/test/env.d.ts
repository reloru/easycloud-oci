import type { Env as AppEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      OCI_TEST_KEY_B64?: string;
      OCI_TEST_USER?: string;
      OCI_TEST_TENANCY?: string;
      OCI_TEST_REGION?: string;
    }
  }
}
