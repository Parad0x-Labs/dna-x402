import { describe, expect, it } from "vitest";
import { buildBuilderFeeWaterfall } from "../src/index.js";

describe("builder monetized agent example", () => {
  it("keeps DNA and builder fees visible and separate", () => {
    const waterfall = buildBuilderFeeWaterfall();
    expect(waterfall.lines.find((line) => line.kind === "DNA_PLATFORM_FEE")).toMatchObject({
      bps: 10,
      visibleToBuyer: true,
    });
    expect(waterfall.lines.find((line) => line.kind === "BUILDER_FEE")).toMatchObject({
      bps: 50,
      collectionStatus: "ACCRUED_NOT_COLLECTED",
      visibleToBuyer: true,
    });
  });
});
