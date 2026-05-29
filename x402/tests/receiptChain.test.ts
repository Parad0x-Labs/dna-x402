import { describe, expect, it } from "vitest";
import {
  parseChainDepth,
  MAX_CHAIN_DEPTH,
  CHAIN_PARENT_HEADER,
  CHAIN_DEPTH_HEADER,
} from "../src/sdk/receiptChain.js";

describe("receipt chain constants", () => {
  it("MAX_CHAIN_DEPTH is 4", () => expect(MAX_CHAIN_DEPTH).toBe(4));
  it("CHAIN_PARENT_HEADER is x-dnp-parent-receipt", () =>
    expect(CHAIN_PARENT_HEADER).toBe("x-dnp-parent-receipt"));
  it("CHAIN_DEPTH_HEADER is x-dnp-chain-depth", () =>
    expect(CHAIN_DEPTH_HEADER).toBe("x-dnp-chain-depth"));
});

describe("parseChainDepth", () => {
  it("returns 0 for undefined", () => expect(parseChainDepth(undefined)).toBe(0));
  it("returns 0 for empty string", () => expect(parseChainDepth("")).toBe(0));
  it("returns 0 for NaN", () => expect(parseChainDepth("notanumber")).toBe(0));
  it("returns 0 for negative", () => expect(parseChainDepth("-5")).toBe(0));
  it("returns 0 for zero", () => expect(parseChainDepth("0")).toBe(0));
  it("returns 1", () => expect(parseChainDepth("1")).toBe(1));
  it("returns 2", () => expect(parseChainDepth("2")).toBe(2));
  it("returns MAX_CHAIN_DEPTH", () =>
    expect(parseChainDepth(String(MAX_CHAIN_DEPTH))).toBe(MAX_CHAIN_DEPTH));
  it("clamps values above MAX+1 to MAX+1", () => {
    expect(parseChainDepth("100")).toBe(MAX_CHAIN_DEPTH + 1);
    expect(parseChainDepth("99999")).toBe(MAX_CHAIN_DEPTH + 1);
  });
  it("returns MAX+1 for MAX+1", () =>
    expect(parseChainDepth(String(MAX_CHAIN_DEPTH + 1))).toBe(MAX_CHAIN_DEPTH + 1));
  it("handles float strings by truncating", () =>
    expect(parseChainDepth("2.9")).toBe(2));
});

describe("fetchWithChain depth guard", () => {
  it("throws synchronously when depth > MAX_CHAIN_DEPTH", async () => {
    const { fetchWithChain } = await import("../src/sdk/receiptChain.js");
    await expect(
      fetchWithChain("https://example.com/api", {
        wallet: {} as never,
        maxSpendAtomic: "1000",
        chain: { parentReceiptId: "r-abc", depth: MAX_CHAIN_DEPTH + 1 },
      }),
    ).rejects.toThrow(/depth.*exceeds/i);
  });

  it("does not throw at exactly MAX_CHAIN_DEPTH", async () => {
    // We can't actually make the HTTP call in unit tests, so just verify
    // the guard doesn't throw for valid depth. We'll let it fail on network.
    const { fetchWithChain } = await import("../src/sdk/receiptChain.js");
    // depth = MAX_CHAIN_DEPTH is valid; it will fail on network, not on guard
    const p = fetchWithChain("https://0.0.0.0:1/nope", {
      wallet: {} as never,
      maxSpendAtomic: "1000",
      chain: { parentReceiptId: "r-abc", depth: MAX_CHAIN_DEPTH },
    });
    // Should reject with network error, not depth error
    await expect(p).rejects.toThrow();
    await expect(p).rejects.not.toThrow(/depth.*exceeds/i);
  });
});
