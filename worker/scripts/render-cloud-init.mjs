// Prints the first-boot script for a sample selection and syntax-checks it with `bash -n`.
// Usage (from worker/): node scripts/render-cloud-init.mjs [a1|micro] [all|default]
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const [role = "a1", which = "all"] = process.argv.slice(2);
const out = join(mkdtempSync(join(tmpdir(), "easycloud-")), "components.mjs");
await build({ entryPoints: ["src/vm/components.ts"], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "error" });
const m = await import(out);
const sel = which === "default"
  ? m.DEFAULT_SELECTION
  : {
      keepalive: { enabled: true },
      docker: { enabled: true },
      cloudflared: { enabled: true, tunnelToken: "eyJhIjoiMTIzNDU2Nzg5MCIsInQiOiJhYmNkZWYiLCJzIjoiWFlaIn0=" },
      tailscale: { enabled: true, authKey: "tskey-auth-kEXAMPLE1234-abcdefghijklmnop", exitNode: true },
    };
const script = m.buildUserData(role, `easycloud-${role}`, sel);
const file = join(tmpdir(), `easycloud-user-data-${role}.sh`);
writeFileSync(file, script);
execFileSync("bash", ["-n", file], { stdio: "inherit" });
const b64 = m.encodeUserData(script);
process.stdout.write(script);
console.error(`\n[render] bash -n OK; script ${script.length} bytes; base64 ${b64.length} bytes (metadata limit 32000 total)`);
