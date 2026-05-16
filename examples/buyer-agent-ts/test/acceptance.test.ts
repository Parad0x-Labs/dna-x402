import { describe, expect, it } from "vitest";
import { assertSpendAllowed, buildCommitPayload, buildQuoteUrl } from "../src/index.js";

describe("buyer agent example", () => {
  it("prepares quote and commit payloads without live money movement", () => {
    expect(buildQuoteUrl()).toContain("/quote");
    expect(buildCommitPayload("quote-1")).toMatchObject({ quoteId: "quote-1" });
    expect(() => assertSpendAllowed("100000")).not.toThrow();
  });
});
