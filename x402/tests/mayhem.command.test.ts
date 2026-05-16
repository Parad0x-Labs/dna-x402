import { describe, expect, it } from "vitest";
import { runMayhem } from "../scripts/mayhem/x402-mayhem.js";

describe("x402 mayhem runner", () => {
  it("fails all configured attacks safely without live money movement", () => {
    const results = runMayhem();
    expect(results.length).toBeGreaterThanOrEqual(15);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.map((result) => result.name)).toEqual(expect.arrayContaining([
      "commit abandonment limit",
      "replay and concurrent replay",
      "sealed bid mismatch",
      "bundle circular dependency",
      "agent overspend and revoked session",
      "webhook replay",
      "fee double charge",
      "tax threshold without profile blocks payout",
      "PII in receipt",
      "denylist without evidence",
    ]));
  });
});
