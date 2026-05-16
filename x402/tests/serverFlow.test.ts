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

class SplitVerifier implements PaymentVerifier {
  async verify(quote: Quote, paymentProof: PaymentProof) {
    if (paymentProof.settlement !== "transfer") {
      return { ok: false, settledOnchain: false, errorCode: "INVALID_PROOF" as const, error: "split proof must be transfer" };
    }
    if (paymentProof.txSignature.startsWith("tx-wrong-recipient-")) {
      return { ok: false, settledOnchain: false, errorCode: "WRONG_RECIPIENT" as const, error: "wrong recipient" };
    }
    if (paymentProof.txSignature.startsWith("tx-wrong-mint-")) {
      return { ok: false, settledOnchain: false, errorCode: "WRONG_MINT" as const, error: "wrong mint" };
    }
    if (paymentProof.amountAtomic && BigInt(paymentProof.amountAtomic) < BigInt(quote.totalAtomic)) {
      return { ok: false, settledOnchain: false, errorCode: "UNDERPAY" as const, error: "underpay" };
    }
    if (paymentProof.txSignature.startsWith("tx-ok-split-")) {
      return { ok: true, settledOnchain: true, txSignature: paymentProof.txSignature };
    }
    return { ok: false, settledOnchain: false, errorCode: "INVALID_PROOF" as const, error: "bad split proof" };
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

const directSplitConfig: X402Config = {
  ...baseConfig,
  feePolicy: {
    ...baseConfig.feePolicy,
    feeBps: 0,
    baseFeeAtomic: 0n,
    minFeeAtomic: 0n,
  },
  builderMonetization: {
    platformFeeBps: 10,
    platformFeeMode: "direct_split",
    platformTreasury: "dna-treasury-public-beta",
    builderFeesEnabled: true,
    builderFeeDefaultMode: "display_only",
    builderFeeMaxBps: 500,
    affiliateFeesEnabled: false,
    affiliateFeeMaxBps: 200,
    directSplitFeesEnabled: true,
    directSplitGateRef: "public-beta-direct-split-2026-05",
    autoSweepRequested: false,
  },
};

describe("x402 server flow", () => {
  it("fails closed on admin operations unless local insecure mode or an admin token is configured", async () => {
    const closed = createX402App(baseConfig, {
      paymentVerifier: new FakeVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    }).app;
    await request(closed).get("/admin/overview").expect(503);
    await request(closed).post("/settlements/flush").send({}).expect(503);

    const local = createX402App({ ...baseConfig, allowInsecure: true }, {
      paymentVerifier: new FakeVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    }).app;
    await request(local).get("/admin/overview").expect(200);
    await request(local).post("/settlements/flush").send({}).expect(200);

    const secret = "test-admin-secret-123456789";
    const secured = createX402App({ ...baseConfig, adminSecret: secret }, {
      paymentVerifier: new FakeVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    }).app;
    await request(secured).get("/admin/overview").expect(403);
    await request(secured).get("/admin/overview").set("x-admin-token", secret).expect(200);
    await request(secured).post("/settlements/flush").send({}).expect(403);
    await request(secured).post("/settlements/flush").set("x-admin-token", secret).send({}).expect(200);
  });

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
    const adminSecret = "test-admin-secret-123456789";
    let nowMs = Date.now();
    const { app } = createX402App(
      {
        ...baseConfig,
        adminSecret,
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
    const flush = await request(app).post("/settlements/flush").set("x-admin-token", adminSecret).send({}).expect(200);
    expect(flush.body.batches).toHaveLength(1);
    expect(flush.body.batches[0].commitIds).toHaveLength(100);
    expect(flush.body.batches[0].settleAmountAtomic).toBe("10100");
    expect(flush.body.batches[0].providerAmountAtomic).toBe("10000");
    expect(flush.body.batches[0].platformFeeAtomic).toBe("100");
  }, 15_000);

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

  it("requires seller and DNA treasury proofs for gated direct split finalize", async () => {
    const { app } = createX402App(directSplitConfig, {
      paymentVerifier: new SplitVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    const first = await request(app).get("/resource").expect(402);
    const requirements = first.body.paymentRequirements;
    expect(requirements.splitPaymentRequirements).toHaveLength(2);
    expect(requirements.splitPaymentRequirements.map((item: any) => item.kind)).toEqual([
      "PROVIDER_AMOUNT",
      "DNA_PLATFORM_FEE",
    ]);

    const quoteId: string = requirements.quote.quoteId;
    const quote = await request(app).get("/quote").query({ resource: "/resource", amountAtomic: "1000000" }).expect(200);
    const lines = quote.body.feeWaterfallV2.lines.filter((line: any) => line.requiredForFinalize);
    const provider = lines.find((line: any) => line.kind === "PROVIDER_AMOUNT");
    const dna = lines.find((line: any) => line.kind === "DNA_PLATFORM_FEE");
    expect(provider.amount).toBe("999000");
    expect(dna.amount).toBe("1000");
    expect(dna.recipient).toBe("dna-treasury-public-beta");

    const commit = await request(app)
      .post("/commit")
      .send({
        quoteId: quote.body.quoteId,
        payerCommitment32B: "0x" + "66".repeat(32),
      })
      .expect(201);

    const finalized = await request(app)
      .post("/finalize")
      .send({
        commitId: commit.body.commitId,
        splitPaymentProofs: [
          {
            feeLineId: provider.id,
            paymentProof: {
              settlement: "transfer",
              txSignature: "tx-ok-split-provider-123456789012345678901234",
              amountAtomic: provider.amount,
            },
          },
          {
            feeLineId: dna.id,
            paymentProof: {
              settlement: "transfer",
              txSignature: "tx-ok-split-dna-123456789012345678901234567890",
              amountAtomic: dna.amount,
            },
          },
        ],
      })
      .expect(200);

    expect(finalized.body.feeAccruals).toBeUndefined();
    expect(finalized.body.splitPaymentResults).toHaveLength(2);
    const receipt = await request(app).get(`/receipt/${finalized.body.receiptId}`).expect(200);
    expect(verifySignedReceipt(receipt.body)).toBe(true);
    expect(receipt.body.payload.feeWaterfallHash).toBe(quote.body.feeWaterfallV2.feeWaterfallHash);
    expect(receipt.body.payload.feeCollectionSummary.dnaPlatformFeeStatus).toBe("COLLECTED_DIRECT_SPLIT");
    expect(receipt.body.payload.splitPaymentProofs.some((item: any) => item.kind === "DNA_PLATFORM_FEE")).toBe(true);
    expect(quoteId).toBeTruthy();
  });

  it("rejects missing, wrong-recipient, underpaid, and replayed DNA direct split proofs", async () => {
    const { app } = createX402App(directSplitConfig, {
      paymentVerifier: new SplitVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    async function quoteAndCommit() {
      const quote = await request(app).get("/quote").query({ resource: "/resource", amountAtomic: "1000000" }).expect(200);
      const lines = quote.body.feeWaterfallV2.lines.filter((line: any) => line.requiredForFinalize);
      const provider = lines.find((line: any) => line.kind === "PROVIDER_AMOUNT");
      const dna = lines.find((line: any) => line.kind === "DNA_PLATFORM_FEE");
      const commit = await request(app)
        .post("/commit")
        .send({
          quoteId: quote.body.quoteId,
          payerCommitment32B: "0x" + "77".repeat(32),
        })
        .expect(201);
      return { provider, dna, commitId: commit.body.commitId };
    }

    const missing = await quoteAndCommit();
    const missingDna = await request(app)
      .post("/finalize")
      .send({
        commitId: missing.commitId,
        splitPaymentProofs: [
          {
            feeLineId: missing.provider.id,
            paymentProof: {
              settlement: "transfer",
              txSignature: "tx-ok-split-provider-missing-123456789012345678",
              amountAtomic: missing.provider.amount,
            },
          },
        ],
      })
      .expect(402);
    expect(missingDna.body.error.code).toBe("X402_MISSING_PAYMENT_PROOF");

    const wrong = await quoteAndCommit();
    const wrongRecipient = await request(app)
      .post("/finalize")
      .send({
        commitId: wrong.commitId,
        splitPaymentProofs: [
          {
            feeLineId: wrong.provider.id,
            paymentProof: {
              settlement: "transfer",
              txSignature: "tx-ok-split-provider-wrong-12345678901234567890",
              amountAtomic: wrong.provider.amount,
            },
          },
          {
            feeLineId: wrong.dna.id,
            paymentProof: {
              settlement: "transfer",
              txSignature: "tx-wrong-recipient-dna-1234567890123456789012",
              amountAtomic: wrong.dna.amount,
            },
          },
        ],
      })
      .expect(402);
    expect(wrongRecipient.body.error.code).toBe("X402_WRONG_RECIPIENT");

    const underpaid = await quoteAndCommit();
    const underpaidDna = await request(app)
      .post("/finalize")
      .send({
        commitId: underpaid.commitId,
        splitPaymentProofs: [
          {
            feeLineId: underpaid.provider.id,
            paymentProof: {
              settlement: "transfer",
              txSignature: "tx-ok-split-provider-underpay-123456789012345678",
              amountAtomic: underpaid.provider.amount,
            },
          },
          {
            feeLineId: underpaid.dna.id,
            paymentProof: {
              settlement: "transfer",
              txSignature: "tx-ok-split-dna-underpay-1234567890123456789012",
              amountAtomic: "1",
            },
          },
        ],
      })
      .expect(402);
    expect(underpaidDna.body.error.code).toBe("X402_UNDERPAY");

    const replay = await quoteAndCommit();
    const proof = {
      settlement: "transfer" as const,
      txSignature: "tx-ok-split-reused-proof-1234567890123456789012",
      amountAtomic: replay.provider.amount,
    };
    const replayed = await request(app)
      .post("/finalize")
      .send({
        commitId: replay.commitId,
        splitPaymentProofs: [
          { feeLineId: replay.provider.id, paymentProof: proof },
          { feeLineId: replay.dna.id, paymentProof: { ...proof, amountAtomic: replay.dna.amount } },
        ],
      })
      .expect(409);
    expect(replayed.body.error.code).toBe("X402_REPLAY_DETECTED");
  });
});
