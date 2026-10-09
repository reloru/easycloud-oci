/**
 * M6: optional VM components installed by cloud-init on first boot, and the
 * "control sheet" for each: single-line commands for status / edit / pause /
 * resume / remove / uninstall-package, so the user keeps full control without
 * the app. One source of truth feeds both the boot script and the sheets.
 *
 * Product rules (CLAUDE.md): components are opt-in (keep-alive recommended),
 * installs are namespaced easycloud-*, the VM keeps a list of packages the app
 * installed, and uninstall commands never remove packages that were already there.
 */

export type Role = "a1" | "micro";

export interface KeepaliveSettings {
  loadPercent: number;
  durationMinutes: number;
  /** systemd OnCalendar expression (VM clock is UTC on OCI images). */
  onCalendar: string;
}

export interface ComponentSelection {
  keepalive?: Partial<KeepaliveSettings> & { enabled: boolean };
  docker?: { enabled: boolean };
  cloudflared?: { enabled: boolean; tunnelToken?: string };
  tailscale?: { enabled: boolean; authKey?: string; exitNode?: boolean };
}

/** Reference defaults (proven: daily P95 ≈ load; each job covers 8.33% of the day). */
export const KEEPALIVE_DEFAULTS: Record<Role, KeepaliveSettings> = {
  a1: { loadPercent: 25, durationMinutes: 30, onCalendar: "*-*-* 00/6:00:00" },
  micro: { loadPercent: 35, durationMinutes: 120, onCalendar: "*-*-* 08:00:00" },
};

export const DEFAULT_SELECTION: ComponentSelection = { keepalive: { enabled: true } };

const DIR = "/etc/easycloud";
const PKGS = `${DIR}/installed-packages`;
const SHEET = `${DIR}/control-sheet.txt`;

export interface ControlAction {
  label: string;
  command: string;
}

export interface ControlSection {
  id: "keepalive" | "docker" | "cloudflared" | "tailscale";
  title: string;
  description: string;
  actions: ControlAction[];
}

export class ComponentError extends Error {}

const TOKEN = /^[A-Za-z0-9+/=_-]{20,4000}$/;
const TS_KEY = /^tskey-[A-Za-z0-9-]{10,200}$/;
const ON_CALENDAR = /^[0-9*/:,. -]{1,60}$/;

export function keepaliveSettings(role: Role, sel: ComponentSelection): KeepaliveSettings {
  const k = { ...KEEPALIVE_DEFAULTS[role], ...stripUndefined(sel.keepalive ?? {}) };
  if (!Number.isInteger(k.loadPercent) || k.loadPercent < 1 || k.loadPercent > 100) throw new ComponentError("Keep-alive load must be 1–100%.");
  if (!Number.isInteger(k.durationMinutes) || k.durationMinutes < 1 || k.durationMinutes > 24 * 60) throw new ComponentError("Keep-alive duration must be 1–1440 minutes.");
  if (!ON_CALENDAR.test(k.onCalendar)) throw new ComponentError("Keep-alive schedule is not a valid systemd calendar expression.");
  return k;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== undefined && k !== "enabled")) as Partial<T>;
}

/** The selection minus secrets, safe to store in plain state and show in the UI. */
export function publicSelection(sel: ComponentSelection): ComponentSelection {
  return {
    ...(sel.keepalive ? { keepalive: { ...sel.keepalive } } : {}),
    ...(sel.docker ? { docker: { enabled: sel.docker.enabled } } : {}),
    ...(sel.cloudflared ? { cloudflared: { enabled: sel.cloudflared.enabled } } : {}),
    ...(sel.tailscale ? { tailscale: { enabled: sel.tailscale.enabled, exitNode: sel.tailscale.exitNode } } : {}),
  };
}

export function validateSelection(sel: ComponentSelection): void {
  keepaliveSettings("a1", sel);
  keepaliveSettings("micro", sel);
  if (sel.cloudflared?.enabled && !TOKEN.test(sel.cloudflared.tunnelToken ?? "")) {
    throw new ComponentError("Paste the Cloudflare Tunnel token (the long code after 'cloudflared service install').");
  }
  if (sel.tailscale?.enabled && !TS_KEY.test(sel.tailscale.authKey ?? "")) {
    throw new ComponentError("Paste a Tailscale auth key (it starts with tskey-).");
  }
}

/** One-line command that applies new keep-alive settings on the VM (generated from the app's form). */
export function keepaliveEditCommand(k: KeepaliveSettings): string {
  return (
    `sudo sed -i -e 's/^LOAD=.*/LOAD=${k.loadPercent}/' -e 's/^DURATION=.*/DURATION=${k.durationMinutes * 60}/' ${DIR}/keepalive.env` +
    ` && sudo sed -i 's|^OnCalendar=.*|OnCalendar=${k.onCalendar}|' /etc/systemd/system/easycloud-keepalive.timer` +
    ` && sudo systemctl daemon-reload && sudo systemctl restart easycloud-keepalive.timer`
  );
}

/** Removes a package only if EasyCloud installed it (listed in the VM's installed-packages file). */
const uninstall = (pkg: string, extra = "") =>
  `if grep -qx ${pkg} ${PKGS} 2>/dev/null; then sudo apt-get remove -y ${pkg}${extra}; else echo "${pkg} was not installed by EasyCloud; left in place."; fi`;

export function controlSheet(role: Role, sel: ComponentSelection): ControlSection[] {
  const sections: ControlSection[] = [];
  if (sel.keepalive?.enabled) {
    const k = keepaliveSettings(role, sel);
    sections.push({
      id: "keepalive",
      title: "Keep-alive",
      description: `Runs a light CPU load (${k.loadPercent}% for ${k.durationMinutes} min on schedule "${k.onCalendar}") so Oracle doesn't treat the server as idle.`,
      actions: [
        { label: "Status", command: "systemctl list-timers easycloud-keepalive.timer --no-pager" },
        { label: "Recent runs", command: "journalctl -u easycloud-keepalive --since -2d --no-pager | tail -n 20" },
        { label: "Edit (current values)", command: keepaliveEditCommand(k) },
        { label: "Pause", command: "sudo systemctl disable --now easycloud-keepalive.timer" },
        { label: "Resume", command: "sudo systemctl enable --now easycloud-keepalive.timer" },
        {
          label: "Remove",
          command: `sudo systemctl disable --now easycloud-keepalive.timer; sudo rm -f /etc/systemd/system/easycloud-keepalive.service /etc/systemd/system/easycloud-keepalive.timer ${DIR}/keepalive.env && sudo systemctl daemon-reload`,
        },
        { label: "Uninstall package (stress-ng)", command: uninstall("stress-ng") },
      ],
    });
  }
  if (sel.docker?.enabled) {
    sections.push({
      id: "docker",
      title: "Docker",
      description: "Runs apps in containers. The ubuntu user can use docker without sudo after logging in again.",
      actions: [
        { label: "Status", command: "systemctl status docker --no-pager | head -n 5 && sudo docker ps" },
        { label: "Pause", command: "sudo systemctl stop docker.socket docker" },
        { label: "Resume", command: "sudo systemctl start docker" },
        { label: "Remove (stop at boot)", command: "sudo systemctl disable --now docker.socket docker" },
        { label: "Uninstall package (docker.io; containers and images stay in /var/lib/docker)", command: uninstall("docker.io") },
      ],
    });
  }
  if (sel.cloudflared?.enabled) {
    sections.push({
      id: "cloudflared",
      title: "Cloudflare Tunnel",
      description: "Connects the server to your Cloudflare account without opening ports.",
      actions: [
        { label: "Status", command: "systemctl status cloudflared --no-pager | head -n 5" },
        { label: "Edit (use a new tunnel token)", command: "sudo cloudflared service uninstall; sudo cloudflared service install PASTE_NEW_TOKEN_HERE" },
        { label: "Pause", command: "sudo systemctl stop cloudflared" },
        { label: "Resume", command: "sudo systemctl start cloudflared" },
        { label: "Remove", command: "sudo cloudflared service uninstall" },
        { label: "Uninstall package (cloudflared)", command: uninstall("cloudflared", " && sudo rm -f /etc/apt/sources.list.d/cloudflared.list") },
      ],
    });
  }
  if (sel.tailscale?.enabled) {
    sections.push({
      id: "tailscale",
      title: "Tailscale",
      description: sel.tailscale.exitNode
        ? "Private network (VPN). This server is offered as an exit node: approve it once in the Tailscale admin console (Machines → this server → Edit route settings → Use as exit node), then pick it on your phone to browse through it."
        : "Private network (VPN) between your devices and this server.",
      actions: [
        { label: "Status", command: "tailscale status" },
        { label: "Exit node on", command: "sudo tailscale set --advertise-exit-node=true" },
        { label: "Exit node off", command: "sudo tailscale set --advertise-exit-node=false" },
        { label: "Pause", command: "sudo systemctl stop tailscaled" },
        { label: "Resume", command: "sudo systemctl start tailscaled" },
        { label: "Remove", command: "sudo tailscale logout; sudo systemctl disable --now tailscaled; sudo rm -f /etc/sysctl.d/99-tailscale.conf" },
        { label: "Uninstall package (tailscale)", command: uninstall("tailscale", " && sudo rm -f /etc/apt/sources.list.d/tailscale.list") },
      ],
    });
  }
  return sections;
}

export function controlSheetText(serverName: string, sections: ControlSection[]): string {
  const lines = [
    `EasyCloud control sheet for ${serverName}`,
    "Copy a command, paste it into the terminal, press Enter. None of these need the EasyCloud app.",
    `Setup log: sudo cat /var/log/easycloud-setup.log   Component status: cat ${DIR}/status`,
    "",
  ];
  for (const s of sections) {
    lines.push(`== ${s.title} ==`, s.description);
    for (const a of s.actions) lines.push(`${a.label}:`, `  ${a.command}`);
    lines.push("");
  }
  if (!sections.length) lines.push("No optional components were installed.");
  return lines.join("\n") + "\n";
}

const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** First-boot script (cloud-init runs it once as root). Each component is isolated: one failure doesn't stop the others. */
export function buildUserData(role: Role, serverName: string, sel: ComponentSelection): string {
  validateSelection(sel);
  const sheet = controlSheetText(serverName, controlSheet(role, sel));
  if (sheet.includes("EASYCLOUD_SHEET_END")) throw new ComponentError("Control sheet contains the heredoc terminator.");
  const parts: string[] = [
    "#!/bin/bash",
    "# EasyCloud first-boot setup. Log: /var/log/easycloud-setup.log",
    "exec >>/var/log/easycloud-setup.log 2>&1",
    "set -u",
    "export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a",
    `mkdir -p ${DIR} && touch ${PKGS} && : > ${DIR}/status`,
    "APT='apt-get -o DPkg::Lock::Timeout=600'",
    `install_pkg() { dpkg -s "$1" >/dev/null 2>&1 && return 0; $APT install -y --no-install-recommends "$1" && echo "$1" >> ${PKGS}; }`,
    `mark() { echo "$1 $2" >> ${DIR}/status; echo "[easycloud] $1: $2"; }`,
    "for _ in 1 2 3; do $APT update && break; sleep 20; done",
  ];

  if (sel.keepalive?.enabled) {
    const k = keepaliveSettings(role, sel);
    parts.push(
      "setup_keepalive() {",
      "  install_pkg stress-ng || return 1",
      `  printf 'LOAD=%s\\nDURATION=%s\\n' ${k.loadPercent} ${k.durationMinutes * 60} > ${DIR}/keepalive.env`,
      "  cat > /etc/systemd/system/easycloud-keepalive.service <<'EOF_UNIT'",
      "[Unit]",
      "Description=EasyCloud keep-alive CPU load",
      "[Service]",
      "Type=oneshot",
      `EnvironmentFile=${DIR}/keepalive.env`,
      "ExecStart=/usr/bin/timeout ${DURATION} /usr/bin/stress-ng --cpu 0 --cpu-load ${LOAD} --quiet",
      "SuccessExitStatus=124",
      // No Nice=: Oracle's CpuUtilization (user + system + steal per the reference deployment) may not count "nice" time.
      "EOF_UNIT",
      "  cat > /etc/systemd/system/easycloud-keepalive.timer <<'EOF_UNIT'",
      "[Unit]",
      "Description=EasyCloud keep-alive schedule",
      "[Timer]",
      `OnCalendar=${k.onCalendar}`,
      "Persistent=true",
      "[Install]",
      "WantedBy=timers.target",
      "EOF_UNIT",
      "  systemctl daemon-reload && systemctl enable --now easycloud-keepalive.timer",
      "}",
      'if setup_keepalive; then mark keepalive ok; else mark keepalive failed; fi',
    );
  }

  if (sel.docker?.enabled) {
    parts.push(
      "setup_docker() { install_pkg docker.io || return 1; systemctl enable --now docker && usermod -aG docker ubuntu; }",
      'if setup_docker; then mark docker ok; else mark docker failed; fi',
    );
  }

  if (sel.cloudflared?.enabled) {
    parts.push(
      "setup_cloudflared() {",
      "  if ! dpkg -s cloudflared >/dev/null 2>&1; then",
      "    install -d -m 0755 /usr/share/keyrings",
      "    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg || return 1",
      "    echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list",
      "    $APT update && install_pkg cloudflared || return 1",
      "  fi",
      `  cloudflared service install ${shq(sel.cloudflared.tunnelToken!)}`,
      "}",
      'if setup_cloudflared; then mark cloudflared ok; else mark cloudflared failed; fi',
    );
  }

  if (sel.tailscale?.enabled) {
    parts.push(
      "setup_tailscale() {",
      "  if ! dpkg -s tailscale >/dev/null 2>&1; then",
      `    curl -fsSL https://tailscale.com/install.sh | sh && dpkg -s tailscale >/dev/null 2>&1 && echo tailscale >> ${PKGS} || return 1`,
      "  fi",
      ...(sel.tailscale.exitNode
        ? [
            "  printf 'net.ipv4.ip_forward = 1\\nnet.ipv6.conf.all.forwarding = 1\\n' > /etc/sysctl.d/99-tailscale.conf",
            "  sysctl -p /etc/sysctl.d/99-tailscale.conf",
          ]
        : []),
      `  tailscale up --auth-key=${shq(sel.tailscale.authKey!)} --hostname=${shq(serverName)}${sel.tailscale.exitNode ? " --advertise-exit-node" : ""}`,
      "}",
      'if setup_tailscale; then mark tailscale ok; else mark tailscale failed; fi',
    );
  }

  parts.push(
    `cat > ${SHEET} <<'EASYCLOUD_SHEET_END'`,
    sheet.trimEnd(),
    "EASYCLOUD_SHEET_END",
    `install -o ubuntu -g ubuntu -m 0644 ${SHEET} /home/ubuntu/EASYCLOUD.txt`,
    'echo "[easycloud] setup finished"',
    "",
  );
  return parts.join("\n");
}

/** base64 of the UTF-8 script, as OCI's metadata.user_data expects. */
export function encodeUserData(script: string): string {
  const bytes = new TextEncoder().encode(script);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
