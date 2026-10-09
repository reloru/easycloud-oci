import { describe, expect, it } from "vitest";
import { encodeRfc3986, ociEndpoint, ociUrl } from "../src/oci/url";

describe("ociUrl", () => {
  it("rebuilds Oracle's documented GET example URL from parts", () => {
    expect(
      ociUrl(ociEndpoint("iaas", "us-phoenix-1"), ["20160918", "instances"], {
        availabilityDomain: "Pjwf: PHX-AD-1",
        compartmentId: "ocid1.compartment.oc1..aaaaaaaam3we6vgnherjq5q2idnccdflvjsnog7mlr6rtdb25gilchfeyjxa",
        displayName: "TeamXInstances",
        volumeId: "ocid1.volume.oc1.phx.abyhqljrgvttnlx73nmrwfaux7kcvzfs3s66izvxf2h4lgvyndsdsnoiwr5q",
      }),
    ).toBe(
      "https://iaas.us-phoenix-1.oraclecloud.com/20160918/instances?availabilityDomain=Pjwf%3A%20PHX-AD-1" +
        "&compartmentId=ocid1.compartment.oc1..aaaaaaaam3we6vgnherjq5q2idnccdflvjsnog7mlr6rtdb25gilchfeyjxa" +
        "&displayName=TeamXInstances" +
        "&volumeId=ocid1.volume.oc1.phx.abyhqljrgvttnlx73nmrwfaux7kcvzfs3s66izvxf2h4lgvyndsdsnoiwr5q",
    );
  });

  it("drops undefined and null query values and omits an empty query", () => {
    expect(ociUrl("https://h.example/", ["a"], { x: undefined, y: null })).toBe("https://h.example/a");
    expect(ociUrl("https://h.example", ["a"], { n: 2, b: false })).toBe("https://h.example/a?n=2&b=false");
  });

  it("encodes path segments individually", () => {
    expect(ociUrl("https://h.example", ["20160918", "a b/c"])).toBe("https://h.example/20160918/a%20b%2Fc");
  });

  it("survives WHATWG URL parsing unchanged for every printable ASCII character", () => {
    let printable = "";
    for (let c = 0x20; c < 0x7f; c++) printable += String.fromCharCode(c);
    const raw = ociUrl("https://h.example", ["p", printable], { [printable]: printable });
    const parsed = new URL(raw);
    expect(`${parsed.origin}${parsed.pathname}${parsed.search}`).toBe(raw);
  });
});

describe("encodeRfc3986", () => {
  it("encodes the characters encodeURIComponent leaves alone", () => {
    expect(encodeRfc3986("!'()*")).toBe("%21%27%28%29%2A");
    expect(encodeRfc3986("a b:c")).toBe("a%20b%3Ac");
    expect(encodeRfc3986("-_.~")).toBe("-_.~");
  });
});
