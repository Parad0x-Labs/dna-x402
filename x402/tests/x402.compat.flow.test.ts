import request from "supertest";
import { describe, expect, it } from "vitest";
import { X402Config } from "../src/config.js";
import { PaymentVerifier } from "../src/paymentVerifier.js";
import { ReceiptSigner } from "../src/receipts.js";
import { createX402App } from "../src/server.js";
import { PaymentProof, Quote } from "../src/types.js";

class CompatFlowVerifier implements PaymentVerifier {
  async verify(_quote: Quote, paymentProof: PaymentProof) {
    if (paymentProof.settlement === "transfer" && paymentProof.txSignature === "tx-ok-123456789012345678901234567890") {
      return { ok: true, settledOnchain: true, txSignature: paymentProof.txSignature };
    }
    return { ok: false, settledOnchain: false, error: "bad proof" };
  }
}

class RetryableRpcVerifier implements PaymentVerifier {
  async verify(_quote: Quote, _paymentProof: PaymentProof) {
    return {
      ok: false,
      settledOnchain: false,
      error: "rpc unavailable: 429 Too Many Requests",
      errorCode: "RPC_UNAVAILABLE" as const,
      retryable: true,
    };
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
  nettingThresholdAtomic: 10_000n,
  nettingIntervalMs: 10_000,
  pauseMarket: false,
  pauseFinalize: false,
  pauseOrders: false,
  disabledShops: [],
  autoDisableReportThreshold: 0,
  allowInsecure: true,
};

describe("x402 compatibility flow", () => {
  it("accepts PAYMENT-REQUIRED then X-PAYMENT retry flow", async () => {
    const { app } = createX402App(config, {
      paymentVerifier: new CompatFlowVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    const first = await request(app).get("/resource").expect(402);
    const paymentRequired = first.header["payment-required"] as string;
    expect(paymentRequired).toBeTruthy();

    const proofPayload = Buffer.from(JSON.stringify({
      txSig: "tx-ok-123456789012345678901234567890",
      scheme: "solana_spl",
    }), "utf8").toString("base64");

    const paid = await request(app)
      .get("/resource")
      .set("PAYMENT-REQUIRED", paymentRequired)
      .set("X-PAYMENT", proofPayload)
      .expect(200);

    expect(paid.body.ok).toBe(true);
    expect(paid.body.receipt.payload.receiptId).toBeTruthy();
  });

  it("returns 400 X402_PROOF_INVALID for malformed tx signature proof", async () => {
    const { app } = createX402App(config, {
      receiptSigner: ReceiptSigner.generate(),
    });

    const first = await request(app).get("/resource").expect(402);
    const paymentRequired = first.header["payment-required"] as string;

    const malformedProof = Buffer.from(JSON.stringify({
      txSig: "not_base58",
      scheme: "solana_spl",
    }), "utf8").toString("base64");

    const response = await request(app)
      .get("/resource")
      .set("PAYMENT-REQUIRED", paymentRequired)
      .set("X-PAYMENT", malformedProof)
      .expect(400);

    expect(response.body.error.code).toBe("X402_PROOF_INVALID");
  });

  it("returns 503 X402_RPC_UNAVAILABLE for retryable verifier rpc failures", async () => {
    const { app } = createX402App(config, {
      paymentVerifier: new RetryableRpcVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    const first = await request(app).get("/resource").expect(402);
    const paymentRequired = first.header["payment-required"] as string;
    const proofPayload = Buffer.from(JSON.stringify({
      txSig: "tx-ok-123456789012345678901234567890",
      scheme: "solana_spl",
    }), "utf8").toString("base64");

    const response = await request(app)
      .get("/resource")
      .set("PAYMENT-REQUIRED", paymentRequired)
      .set("X-PAYMENT", proofPayload)
      .expect(503);

    expect(response.body.error.code).toBe("X402_RPC_UNAVAILABLE");
  });
});
