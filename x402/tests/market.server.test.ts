import request from "supertest";
import { describe, expect, it } from "vitest";
import { X402Config } from "../src/config.js";
import { createX402App } from "../src/server.js";
import { PaymentVerifier } from "../src/paymentVerifier.js";
import { PaymentProof, Quote } from "../src/types.js";
import { ReceiptSigner } from "../src/receipts.js";
import { verifyQuoteSignature } from "../src/market/quotes.js";
import { makeSignedShop } from "./market.helpers.js";

class FakeVerifier implements PaymentVerifier {
  async verify(_quote: Quote, paymentProof: PaymentProof) {
    if (paymentProof.settlement === "transfer" && paymentProof.txSignature === "tx-ok-123456789012345678901234567890") {
      return { ok: true, settledOnchain: true, txSignature: paymentProof.txSignature };
    }
    return { ok: false, settledOnchain: false, error: "bad proof" };
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
    feeBps: 100,
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

describe("market routes on x402 server", () => {
  it("serves market discovery, signed quotes, and telemetry after paid calls", async () => {
    const { app } = createX402App(baseConfig, {
      paymentVerifier: new FakeVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    await request(app).post("/market/shops").send(makeSignedShop({
      shopId: "shop-a",
      capability: "pdf_summarize",
      priceAtomic: "1200",
      maxLatencyMs: 1300,
    })).expect(201);

    await request(app).post("/market/shops").send(makeSignedShop({
      shopId: "shop-b",
      capability: "pdf_summarize",
      priceAtomic: "900",
      maxLatencyMs: 900,
    })).expect(201);

    const search = await request(app)
      .get("/market/search")
      .query({ capability: "pdf_summarize", maxPrice: "2000", maxLatencyMs: 2000 })
      .expect(200);

    expect(search.body.results.length).toBeGreaterThanOrEqual(2);

    await request(app).post("/market/heartbeat").send({
      shopId: "shop-a",
      inflight: 2,
      queueDepth: 3,
      p95LatencyMs: 700,
      errorRate: 0,
    }).expect(200);

    const quotes = await request(app)
      .get("/market/quotes")
      .query({ capability: "pdf_summarize", maxPrice: "4000", limit: 10 })
      .expect(200);

    expect(quotes.body.quotes.length).toBeGreaterThanOrEqual(2);
    const signerPublicKey = quotes.body.signerPublicKey as string;
    for (const quote of quotes.body.quotes as Array<any>) {
      expect(verifyQuoteSignature(quote, signerPublicKey)).toBe(true);
    }

    const first = await request(app).get("/resource").expect(402);
    const quoteId: string = first.body.paymentRequirements.quote.quoteId;

    const commit = await request(app)
      .post("/commit")
      .send({
        quoteId,
        payerCommitment32B: "0x" + "33".repeat(32),
      })
      .expect(201);

    await request(app)
      .post("/finalize")
      .send({
        commitId: commit.body.commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-123456789012345678901234567890",
        },
      })
      .expect(200);

    await request(app)
      .get("/resource")
      .set("x-dnp-commit-id", commit.body.commitId)
      .expect(200);

    const topSelling = await request(app).get("/market/top-selling").query({ window: "24h" }).expect(200);
    expect(topSelling.body.results.some((row: { key: string }) => row.key === "dnp-core::resource")).toBe(true);

    const snapshot = await request(app).get("/market/snapshot").expect(200);
    expect(snapshot.body).toHaveProperty("topCapabilitiesByDemandVelocity");
    expect(snapshot.body).toHaveProperty("recommendedProviders");
  });
});
