import request from "supertest";
import { describe, expect, it } from "vitest";
import { X402Config } from "../src/config.js";
import { PaymentVerifier } from "../src/paymentVerifier.js";
import { ReceiptSigner } from "../src/receipts.js";
import { createX402App } from "../src/server.js";
import { PaymentProof, Quote } from "../src/types.js";

class FakeVerifier implements PaymentVerifier {
  async verify(_quote: Quote, paymentProof: PaymentProof) {
    if (paymentProof.settlement === "transfer") {
      return { ok: true, settledOnchain: true, txSignature: paymentProof.txSignature };
    }
    return { ok: true, settledOnchain: false };
  }
}

const baseConfig: X402Config = {
  port: 8080,
  appVersion: "test",
  solanaRpcUrl: "https://api.devnet.solana.com",
  usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  paymentRecipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
  defaultCurrency: "USDC",
  enabledPricingModels: ["flat", "surge", "stream"],
  marketplaceSelection: "cheapest_sla_else_limit_order",
  quoteTtlSeconds: 120,
  feePolicy: {
    baseFeeAtomic: 0n,
    feeBps: 50,
    minFeeAtomic: 0n,
    accrueThresholdAtomic: 100n,
    minSettleAtomic: 0n,
  },
  nettingThresholdAtomic: 10_000n,
  nettingIntervalMs: 10_000,
  pauseMarket: false,
  pauseFinalize: false,
  pauseOrders: false,
  disabledShops: [],
  autoDisableReportThreshold: 0,
};

describe("pause flags", () => {
  it("blocks finalize when PAUSE_FINALIZE is enabled", async () => {
    const { app } = createX402App(
      { ...baseConfig, pauseFinalize: true },
      {
        paymentVerifier: new FakeVerifier(),
        receiptSigner: ReceiptSigner.generate(),
      },
    );

    const first = await request(app).get("/resource").expect(402);
    const quoteId: string = first.body.paymentRequirements.quote.quoteId;
    const commit = await request(app)
      .post("/commit")
      .send({
        quoteId,
        payerCommitment32B: "0x" + "55".repeat(32),
      })
      .expect(201);

    const finalize = await request(app)
      .post("/finalize")
      .send({
        commitId: commit.body.commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-123456789012345678901234567890",
        },
      })
      .expect(503);

    expect(finalize.body.error.code).toBe("X402_PAUSED");
    expect(finalize.body.error.traceId).toBeTruthy();
    expect(finalize.headers["x-trace-id"]).toBe(finalize.body.error.traceId);
  });

  it("blocks market and orders when pause flags are enabled", async () => {
    const { app } = createX402App(
      { ...baseConfig, pauseMarket: true, pauseOrders: true },
      {
        paymentVerifier: new FakeVerifier(),
        receiptSigner: ReceiptSigner.generate(),
      },
    );

    const pausedMarket = await request(app).get("/market/quotes").expect(503);
    expect(pausedMarket.body.error).toBe("market_paused");

    const pausedOrders = await request(app).post("/market/orders").send({
      capability: "inference",
      maxPrice: "1000",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }).expect(503);
    expect(pausedOrders.body.error).toBe("market_paused");
  });
});
