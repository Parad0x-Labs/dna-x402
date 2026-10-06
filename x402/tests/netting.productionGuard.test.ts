import express from "express";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { assertUnverifiedNettingAllowed } from "../src/sdk/paymentSupport.js";
import { dnaPaywall } from "../src/sdk/paywall.js";
import { dnaSeller } from "../src/sdk/seller.js";

describe("unverified netting is refused in production by the SDK", () => {
  it("assertUnverifiedNettingAllowed", () => {
    expect(() => assertUnverifiedNettingAllowed(true, { NODE_ENV: "production" })).toThrow(/cannot be true in production/);
    expect(() => assertUnverifiedNettingAllowed(false, { NODE_ENV: "production" })).not.toThrow();
    expect(() => assertUnverifiedNettingAllowed(true, { NODE_ENV: "development" })).not.toThrow();
  });

  it("dnaSeller and dnaPaywall refuse unsafeUnverifiedNettingEnabled when NODE_ENV=production", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const recipient = Keypair.generate().publicKey.toBase58();
      expect(() => dnaSeller(express(), { recipient, unsafeUnverifiedNettingEnabled: true, solanaRpcUrl: "http://127.0.0.1:1" }))
        .toThrow(/cannot be true in production/);
      expect(() => dnaPaywall({ priceAtomic: "1", recipient, unsafeUnverifiedNettingEnabled: true, solanaRpcUrl: "http://127.0.0.1:1" } as Parameters<typeof dnaPaywall>[0]))
        .toThrow(/cannot be true in production/);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
