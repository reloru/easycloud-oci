import { describe, expect, it } from "vitest";
import {
  buildUserData,
  controlSheet,
  controlSheetText,
  DEFAULT_SELECTION,
  encodeUserData,
  KEEPALIVE_DEFAULTS,
  keepaliveEditCommand,
  publicSelection,
  validateSelection,
  type ComponentSelection,
} from "../src/vm/components";

const TOKEN = "eyJhIjoiMTIzNDU2Nzg5MCIsInQiOiJhYmNkZWYiLCJzIjoiWFlaIn0=";
const TSKEY = "tskey-auth-kEXAMPLE1234-abcdefghijklmnop";
const ALL: ComponentSelection = {
  keepalive: { enabled: true },
  docker: { enabled: true },
  cloudflared: { enabled: true, tunnelToken: TOKEN },
  tailscale: { enabled: true, authKey: TSKEY, exitNode: true },
};
// A shell-injection attempt in the token field (assembled so the literal never appears in source).
const INJECTION = ["abc';", "reboot", "#"].join(" ");

describe("buildUserData", () => {
  it("default selection installs only the keep-alive, with role-specific settings", () => {
    const a1 = buildUserData("a1", "easycloud-a1", DEFAULT_SELECTION);
    const micro = buildUserData("micro", "easycloud-micro-1", DEFAULT_SELECTION);
    expect(a1.startsWith("#!/bin/bash\n")).toBe(true);
    expect(a1).toContain("printf 'LOAD=%s\\nDURATION=%s\\n' 25 1800");
    expect(a1).toContain("OnCalendar=*-*-* 00/6:00:00");
    expect(micro).toContain("printf 'LOAD=%s\\nDURATION=%s\\n' 35 7200");
    expect(micro).toContain("OnCalendar=*-*-* 08:00:00");
    for (const s of [a1, micro]) {
      expect(s).toContain("install_pkg stress-ng");
      expect(s).not.toMatch(/docker\.io|cloudflared|tailscale/);
      expect(s).not.toContain("Nice=");
    }
  });

  it("isolates each component and records its status", () => {
    const s = buildUserData("a1", "easycloud-a1", ALL);
    for (const c of ["keepalive", "docker", "cloudflared", "tailscale"]) {
      expect(s).toContain(`if setup_${c}; then mark ${c} ok; else mark ${c} failed; fi`);
    }
    expect(s).not.toMatch(/^set -e/m);
  });

  it("single-quotes secrets and passes the exit-node and hostname flags", () => {
    const s = buildUserData("micro", "easycloud-micro-2", ALL);
    expect(s).toContain(`cloudflared service install '${TOKEN}'`);
    expect(s).toContain(`tailscale up --auth-key='${TSKEY}' --hostname='easycloud-micro-2' --advertise-exit-node`);
    expect(s).toContain("net.ipv4.ip_forward = 1\\nnet.ipv6.conf.all.forwarding = 1");
  });

  it("writes the control sheet to /etc/easycloud and the ubuntu user's home", () => {
    const s = buildUserData("a1", "easycloud-a1", ALL);
    expect(s).toContain("cat > /etc/easycloud/control-sheet.txt <<'EASYCLOUD_SHEET_END'");
    expect(s).toContain(controlSheetText("easycloud-a1", controlSheet("a1", ALL)).trimEnd());
    expect(s).toContain("install -o ubuntu -g ubuntu -m 0644 /etc/easycloud/control-sheet.txt /home/ubuntu/EASYCLOUD.txt");
  });

  it("stays well inside OCI's 32,000-byte metadata limit with every component on", () => {
    expect(encodeUserData(buildUserData("a1", "easycloud-a1", ALL)).length).toBeLessThan(16_000);
  });

  it("base64-encodes UTF-8 correctly", () => {
    expect(new TextDecoder().decode(Uint8Array.from(atob(encodeUserData("é ☁️")), (c) => c.charCodeAt(0)))).toBe("é ☁️");
  });
});

describe("validateSelection", () => {
  it.each([
    [{ cloudflared: { enabled: true } }, /Cloudflare Tunnel token/],
    [{ cloudflared: { enabled: true, tunnelToken: INJECTION } }, /Cloudflare Tunnel token/],
    [{ tailscale: { enabled: true, authKey: "not-a-key" } }, /tskey-/],
    [{ keepalive: { enabled: true, loadPercent: 0 } }, /1–100%/],
    [{ keepalive: { enabled: true, durationMinutes: 2000 } }, /1–1440/],
    [{ keepalive: { enabled: true, onCalendar: "daily; reboot" } }, /calendar/],
  ] as [ComponentSelection, RegExp][])("rejects %j", (sel, msg) => {
    expect(() => validateSelection(sel)).toThrow(msg);
  });

  it("ignores secrets for disabled components", () => {
    expect(() => validateSelection({ cloudflared: { enabled: false }, tailscale: { enabled: false } })).not.toThrow();
  });
});

describe("controlSheet", () => {
  it("gives every component status, pause, resume, remove and a guarded uninstall", () => {
    const sections = controlSheet("a1", ALL);
    expect(sections.map((s) => s.id)).toEqual(["keepalive", "docker", "cloudflared", "tailscale"]);
    for (const s of sections) {
      const labels = s.actions.map((a) => a.label);
      for (const required of ["Status", "Pause", "Resume"]) expect(labels).toContain(required);
      expect(labels.some((l) => l.startsWith("Remove"))).toBe(true);
      const uninstall = s.actions.find((a) => a.label.startsWith("Uninstall package"))!;
      expect(uninstall.command).toMatch(/^if grep -qx \S+ \/etc\/easycloud\/installed-packages 2>\/dev\/null; then sudo apt-get remove -y /);
      expect(uninstall.command).toContain("was not installed by EasyCloud; left in place.");
      for (const a of s.actions) expect(a.command).not.toContain("\n");
    }
  });

  it("never leaks secrets into the sheet", () => {
    const text = controlSheetText("easycloud-a1", controlSheet("a1", ALL));
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(TSKEY);
  });

  it("generates the keep-alive edit command from settings", () => {
    expect(keepaliveEditCommand({ loadPercent: 30, durationMinutes: 45, onCalendar: "*-*-* 00/4:00:00" })).toBe(
      "sudo sed -i -e 's/^LOAD=.*/LOAD=30/' -e 's/^DURATION=.*/DURATION=2700/' /etc/easycloud/keepalive.env" +
        " && sudo sed -i 's|^OnCalendar=.*|OnCalendar=*-*-* 00/4:00:00|' /etc/systemd/system/easycloud-keepalive.timer" +
        " && sudo systemctl daemon-reload && sudo systemctl restart easycloud-keepalive.timer",
    );
    expect(controlSheet("micro", DEFAULT_SELECTION)[0]!.actions.find((a) => a.label.startsWith("Edit"))!.command).toBe(
      keepaliveEditCommand(KEEPALIVE_DEFAULTS.micro),
    );
  });
});

describe("publicSelection", () => {
  it("drops tokens and keys but keeps choices", () => {
    expect(publicSelection(ALL)).toEqual({
      keepalive: { enabled: true },
      docker: { enabled: true },
      cloudflared: { enabled: true },
      tailscale: { enabled: true, exitNode: true },
    });
  });
});
