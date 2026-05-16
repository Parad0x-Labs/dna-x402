import request from "supertest";
import { describe, expect, it } from "vitest";
import { X402Config } from "../src/config.js";
import { PaymentVerifier } from "../src/paymentVerifier.js";
import { ReceiptSigner, verifySignedReceipt } from "../src/receipts.js";
import { createX402App } from "../src/server.js";
import { PaymentProof, Quote } from "../src/types.js";
import { makeSignedShop } from "./market.helpers.js";

class SandboxVerifier implements PaymentVerifier {
  async verify(_quote: Quote, paymentProof: PaymentProof) {
    if (paymentProof.settlement === "transfer" && paymentProof.txSignature.startsWith("tx-sandbox-")) {
      return { ok: true, settledOnchain: true, txSignature: paymentProof.txSignature };
    }
    return { ok: false, settledOnchain: false, error: "sandbox proof rejected", errorCode: "INVALID_PROOF" as const };
  }
}

const baseConfig: X402Config = {
  port: 8080,
  appVersion: "marketplace-checkout-test",
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
  adminSecret: "test-admin-secret-123456789",
};

function createSandboxApp() {
  return createX402App(baseConfig, {
    paymentVerifier: new SandboxVerifier(),
    receiptSigner: ReceiptSigner.generate(),
  });
}

describe("marketplace sandbox checkout and fulfillment", () => {
  it("runs listing -> quote comparison -> commit -> sandbox proof -> receipt -> paid retry", async () => {
    const created = createSandboxApp();
    try {
      await request(created.app).post("/market/shops").send(makeSignedShop({
        shopId: "sandbox-api",
        capability: "data",
        endpointId: "sandbox-api-resource",
        path: "/resource",
        priceAtomic: "1000",
        settlementModes: ["transfer"],
      })).expect(201);

      const marketQuotes = await request(created.app)
        .get("/market/quotes")
        .query({ capability: "data" })
        .expect(200);
      expect(marketQuotes.body.quotes).toHaveLength(1);
      const selected = marketQuotes.body.quotes[0];
      expect(selected.path).toBe("/resource");

      const quote = await request(created.app)
        .get("/quote")
        .query({ resource: selected.path, amountAtomic: selected.price })
        .expect(200);

      const commit = await request(created.app)
        .post("/commit")
        .send({ quoteId: quote.body.quoteId, payerCommitment32B: `0x${"77".repeat(32)}` })
        .expect(201);

      const finalized = await request(created.app)
        .post("/finalize")
        .send({
          commitId: commit.body.commitId,
          paymentProof: {
            settlement: "transfer",
            txSignature: "tx-sandbox-checkout-123456789012345678901234",
          },
        })
        .expect(200);

      const receipt = await request(created.app).get(`/receipt/${finalized.body.receiptId}`).expect(200);
      expect(verifySignedReceipt(receipt.body)).toBe(true);

      const fulfilled = await request(created.app)
        .get("/resource")
        .set("x-dnp-commit-id", commit.body.commitId)
        .expect(200);
      expect(fulfilled.body.ok).toBe(true);
      expect(fulfilled.body.receipt.payload.receiptId).toBe(finalized.body.receiptId);
    } finally {
      clearInterval(created.context.market.orderPollTimer);
    }
  });

  it("creates a manifest version on listing edit and blocks disabled listing quotes", async () => {
    const created = createSandboxApp();
    try {
      await request(created.app).post("/market/shops").send(makeSignedShop({
        shopId: "versioned-api",
        capability: "data",
        priceAtomic: "1000",
      })).expect(201);
      await request(created.app).post("/market/shops").send(makeSignedShop({
        shopId: "versioned-api",
        capability: "data",
        priceAtomic: "1500",
      })).expect(201);

      const versions = await request(created.app).get("/market/shops/versioned-api/versions").expect(200);
      expect(versions.body.versions).toHaveLength(2);
      expect(versions.body.versions[0].manifestHash).not.toBe(versions.body.versions[1].manifestHash);

      await request(created.app)
        .post("/admin/market/shops/versioned-api/disable")
        .set("x-admin-token", baseConfig.adminSecret as string)
        .send({})
        .expect(200);

      const quotes = await request(created.app).get("/market/quotes").query({ capability: "data" }).expect(200);
      expect(quotes.body.quotes).toHaveLength(0);
    } finally {
      clearInterval(created.context.market.orderPollTimer);
    }
  });
});
