import request from "supertest";
import { describe, expect, it } from "vitest";
import { X402Config } from "../src/config.js";
import { createX402App } from "../src/server.js";
import { ReceiptSigner } from "../src/receipts.js";
import { PaymentVerifier } from "../src/paymentVerifier.js";
import { PaymentProof, Quote } from "../src/types.js";
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

describe("market safety policy", () => {
  it("blocks publish for denylist keyword", async () => {
    const { app } = createX402App(baseConfig, {
      paymentVerifier: new FakeVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    const payload = makeSignedShop({
      shopId: "shop-vpn",
      capability: "inference",
      description: "best vpn proxy tunnel",
    });

    const res = await request(app).post("/market/shops").send(payload).expect(422);
    expect(res.body.error).toBe("POLICY_BLOCKED");
    expect(res.body.matched_keyword).toBe("vpn");
  });

  it("blocks publish for unsafe category", async () => {
    const { app } = createX402App(baseConfig, {
      paymentVerifier: new FakeVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    const payload = makeSignedShop({
      shopId: "shop-unsafe-category",
      capability: "inference",
    });
    payload.manifest.category = "prediction_market" as any;

    const res = await request(app).post("/market/shops").send(payload).expect(422);
    expect(res.body.error).toBe("POLICY_BLOCKED");
    expect(res.body.reason).toBe("unsafe_category");
  });

  it("stores abuse reports and lowers reputation", async () => {
    const { app } = createX402App(baseConfig, {
      paymentVerifier: new FakeVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    await request(app).post("/market/shops").send(makeSignedShop({
      shopId: "shop-reportable",
      capability: "inference",
      category: "ai_inference",
    })).expect(201);

    const before = await request(app)
      .get("/market/reputation")
      .query({ shopId: "shop-reportable" })
      .expect(200);

    await request(app)
      .post("/market/report")
      .send({
        shopId: "shop-reportable",
        reportType: "scam",
        reason: "did not return expected output",
      })
      .expect(201);

    const after = await request(app)
      .get("/market/reputation")
      .query({ shopId: "shop-reportable" })
      .expect(200);

    expect(after.body.report_count).toBe(1);
    expect(after.body.score.reportCount).toBe(1);
    expect(after.body.score.warning).toBe(true);
    expect(after.body.score.sellerScore).toBeLessThanOrEqual(before.body.score.sellerScore);
  });

  it("blocks disabled shops from routing and publish", async () => {
    const { app } = createX402App({
      ...baseConfig,
      disabledShops: ["shop-disabled"],
    }, {
      paymentVerifier: new FakeVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    await request(app).post("/market/shops").send(makeSignedShop({
      shopId: "shop-disabled",
      capability: "inference",
      category: "ai_inference",
    })).expect(423);

    await request(app).post("/market/shops").send(makeSignedShop({
      shopId: "shop-enabled",
      capability: "inference",
      category: "ai_inference",
    })).expect(201);

    const quotes = await request(app)
      .get("/market/quotes")
      .query({ capability: "inference", maxPrice: "5000", limit: 10 })
      .expect(200);

    expect((quotes.body.quotes as Array<{ shopId: string }>).some((quote) => quote.shopId === "shop-disabled")).toBe(false);
  });
});
