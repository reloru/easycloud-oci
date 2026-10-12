import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Live OCI test inputs (read-only calls). Present only when the cloud environment defines them.
const LIVE_VARS = ["OCI_KEY_B64", "OCI_USER", "OCI_TENANCY", "OCI_REGION"] as const;
const live = Object.fromEntries(LIVE_VARS.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : [])));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // TEST-ONLY data key; production uses `wrangler secret put KEY_ENCRYPTION_KEY`.
          KEY_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
          // Tests run on this host; production uses https://eazycloud.app from wrangler.jsonc.
          ORIGIN: "https://eazycloud.example",
          RP_ID: "eazycloud.example",
          ...live,
        },
      },
    }),
  ],
});
