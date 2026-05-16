import { describe, expect, it } from "vitest";
import { assertFeeWaterfallHash } from "../src/index.js";

describe("receipt verifier example", () => {
  it("fails closed on fee waterfall mismatch", () => {
    expect(() => assertFeeWaterfallHash({ payload: { feeWaterfallHash: "a" } } as any, "b")).toThrow(/fee waterfall/);
  });
});
