import request from "supertest";
import { describe, expect, it } from "vitest";
import { X402Config } from "../src/config.js";
import { PaymentVerifier } from "../src/paymentVerifier.js";
import { ReceiptSigner, verifySignedReceipt } from "../src/receipts.js";
import { createX402App } from "../src/server.js";
import { PaymentProof, Quote } from "../src/types.js";

class FakeVerifier implements PaymentVerifier {
  async verify(_quote: Quote, paymentProof: PaymentProof) {
    if (paymentProof.settlement === "transfer" && paymentProof.txSignature === "tx-ok-123456789012345678901234567890") {
      return { ok: true, settledOnchain: true, txSignature: paymentProof.txSignature };
    }
    if (paymentProof.settlement === "stream") {
      return { ok: true, settledOnchain: false, streamId: paymentProof.streamId };
    }
    if (paymentProof.settlement === "netting") {
      return { ok: true, settledOnchain: false };
    }
    return { ok: false, settledOnchain: false, error: "bad proof" };
  }
}

class UnderpayVerifier implements PaymentVerifier {
  async verify(_quote: Quote, _paymentProof: PaymentProof) {
    return { ok: false, settledOnchain: false, error: "underpay: amount below quote total" };
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

describe("x402 server flow", () => {
  it("serves 402 -> commit/finalize -> 200 with signed receipt", async () => {
    const { app } = createX402App(baseConfig, {
      paymentVerifier: new FakeVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    const first = await request(app).get("/resource").expect(402);
    const quoteId: string = first.body.paymentRequirements.quote.quoteId;
    expect(first.body.paymentRequirements.accepts.length).toBeGreaterThanOrEqual(2);
    expect(first.body.paymentRequirements.recommendedMode).toBeTruthy();

    const commit = await request(app)
      .post("/commit")
      .send({
        quoteId,
        payerCommitment32B: "0x" + "11".repeat(32),
      })
      .expect(201);

    const commitId: string = commit.body.commitId;

    const finalized = await request(app)
      .post("/finalize")
      .send({
        commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-123456789012345678901234567890",
        },
      })
      .expect(200);

    const retry = await request(app).get("/resource").set("x-dnp-commit-id", commitId).expect(200);
    expect(retry.body.ok).toBe(true);
    expect(retry.body.receipt.payload.receiptId).toBe(finalized.body.receiptId);

    const receipt = await request(app).get(`/receipt/${finalized.body.receiptId}`).expect(200);
    expect(verifySignedReceipt(receipt.body)).toBe(true);
  });

  it("aggregates tiny netting receipts and flushes one batch", async () => {
    let nowMs = Date.now();
    const { app } = createX402App(
      {
        ...baseConfig,
        unsafeUnverifiedNettingEnabled: true,
        feePolicy: {
          ...baseConfig.feePolicy,
          minSettleAtomic: 1_000_000n,
        },
      },
      {
        paymentVerifier: new FakeVerifier(),
        receiptSigner: ReceiptSigner.generate(),
        now: () => new Date(nowMs),
      },
    );

    const commitIds: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      const q = await request(app)
        .get("/quote")
        .query({ resource: "/resource", amountAtomic: "100" })
        .expect(200);

      const c = await request(app)
        .post("/commit")
        .send({
          quoteId: q.body.quoteId,
          payerCommitment32B: "0x" + "22".repeat(32),
        })
        .expect(201);

      commitIds.push(c.body.commitId);

      await request(app)
        .post("/finalize")
        .send({
          commitId: c.body.commitId,
          paymentProof: {
            settlement: "netting",
          },
        })
        .expect(200);
    }

    nowMs += 11_000;
    const flush = await request(app).post("/settlements/flush").send({}).expect(200);
    expect(flush.body.batches).toHaveLength(1);
    expect(flush.body.batches[0].commitIds).toHaveLength(100);
    expect(flush.body.batches[0].settleAmountAtomic).toBe("10100");
    expect(flush.body.batches[0].providerAmountAtomic).toBe("10000");
    expect(flush.body.batches[0].platformFeeAtomic).toBe("100");
  });

  it("does not advertise or accept unsigned netting by default", async () => {
    const { app } = createX402App(
      {
        ...baseConfig,
        feePolicy: {
          ...baseConfig.feePolicy,
          minSettleAtomic: 1_000_000n,
        },
      },
      {
        paymentVerifier: new FakeVerifier(),
        receiptSigner: ReceiptSigner.generate(),
      },
    );

    const quote = await request(app)
      .get("/quote")
      .query({ resource: "/resource", amountAtomic: "100" })
      .expect(200);

    expect(quote.body.settlement).toEqual(["transfer", "stream"]);

    const commit = await request(app)
      .post("/commit")
      .send({
        quoteId: quote.body.quoteId,
        payerCommitment32B: "0x" + "33".repeat(32),
      })
      .expect(201);

    await request(app)
      .post("/finalize")
      .send({
        commitId: commit.body.commitId,
        paymentProof: {
          settlement: "netting",
        },
      })
      .expect(400);
  });

  it("returns X402_UNDERPAY when verifier detects underpayment", async () => {
    const { app } = createX402App(baseConfig, {
      paymentVerifier: new UnderpayVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    const first = await request(app).get("/resource").expect(402);
    const quoteId: string = first.body.paymentRequirements.quote.quoteId;

    const commit = await request(app)
      .post("/commit")
      .send({
        quoteId,
        payerCommitment32B: "0x" + "55".repeat(32),
      })
      .expect(201);

    const finalized = await request(app)
      .post("/finalize")
      .send({
        commitId: commit.body.commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-underpay-test-1234567890123456789012",
          amountAtomic: "1",
        },
      })
      .expect(402);

    expect(finalized.body.error.code).toBe("X402_UNDERPAY");
  });
});
