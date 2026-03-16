import request from "supertest";
import { describe, expect, it } from "vitest";
import { X402Config } from "../src/config.js";
import { PaymentVerifier } from "../src/paymentVerifier.js";
import { createX402App } from "../src/server.js";
import { ReceiptSigner } from "../src/receipts.js";
import { PaymentProof, Quote } from "../src/types.js";

class ReplayVerifier implements PaymentVerifier {
  async verify(_quote: Quote, paymentProof: PaymentProof) {
    if (paymentProof.settlement === "transfer") {
      return { ok: true, settledOnchain: true, txSignature: paymentProof.txSignature };
    }
    if (paymentProof.settlement === "stream") {
      return { ok: true, settledOnchain: true, streamId: paymentProof.streamId };
    }
    return { ok: false, settledOnchain: false, error: "bad" };
  }
}

const config: X402Config = {
  port: 0,
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
    feeBps: 0,
    minFeeAtomic: 0n,
    accrueThresholdAtomic: 100n,
    minSettleAtomic: 0n,
  },
  nettingThresholdAtomic: 1000n,
  nettingIntervalMs: 1000,
  pauseMarket: false,
  pauseFinalize: false,
  pauseOrders: false,
  disabledShops: [],
  autoDisableReportThreshold: 0,
  allowInsecure: true,
};

describe("x402 replay defense", () => {
  it("rejects reusing same tx signature for compat payment", async () => {
    const { app } = createX402App(config, {
      paymentVerifier: new ReplayVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    const requiredRes = await request(app).get("/resource").expect(402);
    const required = requiredRes.header["payment-required"] as string;

    const proof = Buffer.from(JSON.stringify({
      txSig: "replay-sig-123456789012345678901234567890",
      scheme: "solana_spl",
    }), "utf8").toString("base64");

    await request(app)
      .get("/resource")
      .set("PAYMENT-REQUIRED", required)
      .set("X-PAYMENT", proof)
      .expect(200);

    const replay = await request(app)
      .get("/resource")
      .set("PAYMENT-REQUIRED", required)
      .set("X-PAYMENT", proof)
      .expect(409);

    expect(replay.body.error.code).toBe("X402_REPLAY_DETECTED");
    expect(replay.body.error.traceId).toBeTruthy();
  });

  it("allows exactly one success for 50 concurrent retries with the same tx signature", async () => {
    const { app } = createX402App(config, {
      paymentVerifier: new ReplayVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    const requiredRes = await request(app).get("/resource").expect(402);
    const required = requiredRes.header["payment-required"] as string;

    const proof = Buffer.from(JSON.stringify({
      txSig: "replay-concurrency-sig-12345678901234567890123456789012",
      scheme: "solana_spl",
    }), "utf8").toString("base64");

    const attempts = await Promise.all(
      Array.from({ length: 50 }, async () => {
        const response = await request(app)
          .get("/resource")
          .set("PAYMENT-REQUIRED", required)
          .set("X-PAYMENT", proof);
        return {
          status: response.status,
          code: response.body?.error?.code as string | undefined,
        };
      }),
    );

    const successCount = attempts.filter((entry) => entry.status === 200).length;
    const replayCount = attempts.filter((entry) => entry.status === 409 && entry.code === "X402_REPLAY_DETECTED").length;
    expect(successCount).toBe(1);
    expect(replayCount).toBe(49);
  });

  it("rejects reusing the same streamId across different commits", async () => {
    const { app } = createX402App(config, {
      paymentVerifier: new ReplayVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    const firstRequired = await request(app).get("/stream-access").expect(402);
    const firstQuoteId = firstRequired.body.paymentRequirements.quote.quoteId as string;
    const firstCommit = await request(app)
      .post("/commit")
      .send({ quoteId: firstQuoteId, payerCommitment32B: "0x" + "41".repeat(32) })
      .expect(201);
    const firstCommitId = firstCommit.body.commitId as string;

    await request(app)
      .post("/finalize")
      .send({
        commitId: firstCommitId,
        paymentProof: {
          settlement: "stream",
          streamId: "stream-replay-1234567890",
          amountAtomic: "100",
        },
      })
      .expect(200);

    const secondRequired = await request(app).get("/stream-access").expect(402);
    const secondQuoteId = secondRequired.body.paymentRequirements.quote.quoteId as string;
    const secondCommit = await request(app)
      .post("/commit")
      .send({ quoteId: secondQuoteId, payerCommitment32B: "0x" + "42".repeat(32) })
      .expect(201);
    const secondCommitId = secondCommit.body.commitId as string;

    const replay = await request(app)
      .post("/finalize")
      .send({
        commitId: secondCommitId,
        paymentProof: {
          settlement: "stream",
          streamId: "stream-replay-1234567890",
          amountAtomic: "100",
        },
      })
      .expect(409);

    expect(replay.body.error.code).toBe("X402_REPLAY_DETECTED");
    expect(replay.body.error.traceId).toBeTruthy();
  });
});
