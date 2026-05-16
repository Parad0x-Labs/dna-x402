import { describe, expect, it } from "vitest";
import { runServerMayhem } from "../scripts/mayhem/x402-server-mayhem.js";

describe("server-level x402 mayhem runner", () => {
  it("fails all integrated attacks safely through HTTP routes", async () => {
    const results = await runServerMayhem();
    const failed = results.filter((result) => !result.ok);
    expect(failed).toEqual([]);
    expect(results.map((result) => result.name)).toEqual(expect.arrayContaining([
      "underpay rejected at finalize",
      "wrong mint rejected at finalize",
      "wrong recipient rejected at finalize",
      "expired quote rejected at commit and finalize",
      "unsupported settlement rejected at finalize",
      "stream reuse rejected",
      "concurrent replay allows only one success",
      "commit reuse is idempotent and creates no second receipt",
      "restricted listing cannot publish",
      "emergency marketplace pause blocks publish and quote",
      "public raw graph query rejected",
      "PII in receipt blocked before write",
    ]));
  }, 30_000);
});
