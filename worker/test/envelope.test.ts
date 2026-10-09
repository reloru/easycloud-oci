import { describe, expect, it } from "vitest";
import { importDataKey, open, seal } from "../src/crypto/envelope";

const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const OTHER = "HxwdHBsaGRgXFhUUExIREA8ODQwLCgkIBwYFBAMCAQA=";

describe("envelope", () => {
  it("round-trips with the same key and associated data", async () => {
    const key = await importDataKey(SECRET);
    const plaintext = crypto.getRandomValues(new Uint8Array(1217));
    const sealed = await seal(key, plaintext, "acct-1");
    expect(await open(key, sealed, "acct-1")).toEqual(plaintext);
  });

  it("uses a fresh IV each time", async () => {
    const key = await importDataKey(SECRET);
    const p = new Uint8Array([1, 2, 3]);
    expect(await seal(key, p, "a")).not.toBe(await seal(key, p, "a"));
  });

  it("refuses to open under different associated data or a different key", async () => {
    const key = await importDataKey(SECRET);
    const sealed = await seal(key, new Uint8Array([1, 2, 3]), "acct-1");
    await expect(open(key, sealed, "acct-2")).rejects.toThrow();
    await expect(open(await importDataKey(OTHER), sealed, "acct-1")).rejects.toThrow();
  });

  it("rejects a data key that is not 32 bytes", async () => {
    await expect(importDataKey("AAAA")).rejects.toThrow(/32 bytes/);
  });
});
