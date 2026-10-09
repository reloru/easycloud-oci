/**
 * Parse the "Configuration file preview" the OCI Console shows after an API
 * key is added (user, fingerprint, tenancy, region, key_file). The preview's
 * region is the Console's currently selected region, not necessarily the home
 * region, so callers must resolve the home region separately.
 */

export interface ConfigPreview {
  user: string;
  fingerprint: string;
  tenancy: string;
  region: string;
}

export type ParseResult = { ok: true; value: ConfigPreview } | { ok: false; errors: string[] };

const PATTERNS: Record<keyof ConfigPreview, RegExp> = {
  user: /^ocid1\.user\.oc\d+\.\.[a-z0-9]+$/,
  tenancy: /^ocid1\.tenancy\.oc\d+\.\.[a-z0-9]+$/,
  fingerprint: /^(?:[0-9a-f]{2}:){15}[0-9a-f]{2}$/,
  region: /^[a-z]+(?:-[a-z]+)+-\d+$/,
};

export function parseConfigPreview(text: string): ParseResult {
  const found: Partial<Record<keyof ConfigPreview, string>> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const name = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (name in PATTERNS) found[name as keyof ConfigPreview] = name === "fingerprint" ? value.toLowerCase() : value;
  }

  const errors: string[] = [];
  for (const [name, pattern] of Object.entries(PATTERNS) as [keyof ConfigPreview, RegExp][]) {
    const value = found[name];
    if (value === undefined) errors.push(`Missing "${name}=" line`);
    else if (!pattern.test(value)) errors.push(`"${name}" does not look valid: ${value}`);
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: found as ConfigPreview };
}
