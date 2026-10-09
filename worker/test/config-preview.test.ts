import { describe, expect, it } from "vitest";
import { parseConfigPreview } from "../src/oci/config-preview";

const USER = "ocid1.user.oc1..aaaaaaaabcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstu";
const TENANCY = "ocid1.tenancy.oc1..aaaaaaaazyxwvutsrqponmlkjihgfedcba765432zyxwvutsrqponmlkji";
const FP = "ad:3e:5e:8d:c4:2f:96:00:c0:3f:93:fe:2b:36:6e:1a";
const PREVIEW = `[DEFAULT]
user=${USER}
fingerprint=${FP}
tenancy=${TENANCY}
region=us-phoenix-1
key_file=<path to your private keyfile> # TODO`;

describe("parseConfigPreview", () => {
  it("parses the Console's configuration file preview", () => {
    expect(parseConfigPreview(PREVIEW)).toEqual({
      ok: true,
      value: { user: USER, fingerprint: FP, tenancy: TENANCY, region: "us-phoenix-1" },
    });
  });

  it("tolerates CRLF, surrounding whitespace, spaces around '=', quotes and an uppercase fingerprint", () => {
    const messy = `  [DEFAULT]\r\n user = "${USER}" \r\nfingerprint= ${FP.toUpperCase()}\r\n tenancy='${TENANCY}'\r\nregion =us-ashburn-1\r\n`;
    const result = parseConfigPreview(messy);
    expect(result.ok && result.value).toEqual({ user: USER, fingerprint: FP, tenancy: TENANCY, region: "us-ashburn-1" });
  });

  it("accepts multi-part region identifiers", () => {
    const result = parseConfigPreview(PREVIEW.replace("us-phoenix-1", "us-gov-ashburn-1"));
    expect(result.ok).toBe(true);
  });

  it("reports every missing or malformed field", () => {
    const result = parseConfigPreview(`user=${TENANCY}\nfingerprint=ad:3e\nregion=Ashburn`);
    expect(result).toEqual({
      ok: false,
      errors: [
        `"user" does not look valid: ${TENANCY}`,
        'Missing "tenancy=" line',
        '"fingerprint" does not look valid: ad:3e',
        '"region" does not look valid: Ashburn',
      ],
    });
  });

  it("rejects empty input", () => {
    const result = parseConfigPreview("");
    expect(result.ok).toBe(false);
  });
});
