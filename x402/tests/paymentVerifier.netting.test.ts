import { describe, expect, it } from "vitest";
import { Connection } from "@solana/web3.js";
import { loadConfig } from "../src/config.js";
import { SolanaPaymentVerifier } from "../src/paymentVerifier.js";
import type { Quote } from "../src/types.js";

const quote: Quote = {
  quoteId: "quote-netting",
  resource: "/resource",
  amountAtomic: "100",
  feeAtomic: "1",
  totalAtomic: "101",
  mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  recipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
  expiresAt: "2099-01-01T00:00:00.000Z",
  settlement: ["transfer", "netting"],
  memoHash: "memo",
};

describe("netting verifier safety", () => {
  it("rejects unverified netting by default", async () => {
    const verifier = new SolanaPaymentVerifier(new Connection("https://api.devnet.solana.com", "confirmed"));
    const result = await verifier.verify(quote, { settlement: "netting" });

    expect(result).toEqual({
      ok: false,
      settledOnchain: false,
      error: "netting settlement requires explicit external liability attestation",
      errorCode: "PAYMENT_INVALID",
      retryable: false,
    });
  });

  it("allows unverified netting only after explicit opt-in", async () => {
    const verifier = new SolanaPaymentVerifier(new Connection("https://api.devnet.solana.com", "confirmed"), {
      allowUnverifiedNetting: true,
    });
    const result = await verifier.verify(quote, { settlement: "netting" });

    expect(result).toEqual({
      ok: true,
      settledOnchain: false,
    });
  });

  it("keeps unsafe unverified netting disabled in config by default", () => {
    const config = loadConfig({});
    expect(config.unsafeUnverifiedNettingEnabled).toBe(false);
  });

  it("parses explicit unsafe netting opt-in from env", () => {
    const config = loadConfig({
      UNSAFE_UNVERIFIED_NETTING_ENABLED: "1",
    });
    expect(config.unsafeUnverifiedNettingEnabled).toBe(true);
  });
});
