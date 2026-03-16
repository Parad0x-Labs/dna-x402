import { describe, expect, it } from "vitest";
import type { Quote, StreamPaymentProof } from "../src/types.js";
import { SolanaPaymentVerifier } from "../src/paymentVerifier.js";

const quote: Quote = {
  quoteId: "quote-stream-1",
  resource: "/stream",
  amountAtomic: "1000",
  feeAtomic: "0",
  totalAtomic: "1000",
  mint: "mint-1",
  recipient: "recipient-1",
  expiresAt: "2026-03-17T00:10:00.000Z",
  settlement: ["stream"],
  memoHash: "memo-stream-1",
};

describe("SolanaPaymentVerifier stream safety", () => {
  it("fails closed when no streamflow client is configured", async () => {
    const verifier = new SolanaPaymentVerifier({} as any);
    const proof: StreamPaymentProof = {
      settlement: "stream",
      streamId: "stream-1",
      topupSignature: "topup-1",
    };

    const verified = await verifier.verify(quote, proof);

    expect(verified).toEqual({
      ok: false,
      settledOnchain: false,
      streamId: "stream-1",
      error: "stream settlement requires a streamflow client for funded-state verification",
      errorCode: "PAYMENT_INVALID",
      retryable: false,
    });
  });

  it("still verifies stream proofs through a configured streamflow client", async () => {
    const verifier = new SolanaPaymentVerifier({} as any, {
      streamflowClient: {
        async getOne() {
          return {
            recipient: "recipient-1",
            mint: "mint-1",
            depositedAmount: { toString: () => "5000" },
            withdrawnAmount: { toString: () => "1000" },
            closed: false,
          };
        },
      },
    });

    const proof: StreamPaymentProof = {
      settlement: "stream",
      streamId: "stream-verified-1",
      topupSignature: "topup-verified-1",
    };

    const verified = await verifier.verify(quote, proof);

    expect(verified.ok).toBe(true);
    expect(verified.settledOnchain).toBe(true);
    expect(verified.streamId).toBe("stream-verified-1");
    expect(verified.fundedAtomic).toBe("4000");
  });
});
