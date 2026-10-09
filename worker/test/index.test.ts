import { describe, expect, it } from "vitest";
import worker from "../src/index";

describe("worker", () => {
  it("answers /health", async () => {
    const res = await worker.fetch(new Request("https://easycloud.example/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("404s unknown paths", async () => {
    const res = await worker.fetch(new Request("https://easycloud.example/nope"));
    expect(res.status).toBe(404);
  });
});
