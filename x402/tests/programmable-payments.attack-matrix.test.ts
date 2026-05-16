import request from "supertest";
import { describe, expect, it } from "vitest";
import { X402Config } from "../src/config.js";
import { PaymentVerifier } from "../src/paymentVerifier.js";
import { createX402App } from "../src/server.js";
import { ReceiptSigner } from "../src/receipts.js";
import { PaymentProof, Quote } from "../src/types.js";
import { PROGRAMMABILITY_FIXTURES } from "../scripts/audit/programmability/fixtures/primitives.js";

class StrictVerifier implements PaymentVerifier {
  async verify(quote: Quote, paymentProof: PaymentProof) {
    const paid = BigInt(paymentProof.amountAtomic ?? quote.totalAtomic);
    if (paid < BigInt(quote.totalAtomic)) {
      return {
        ok: false,
        settledOnchain: false,
        error: "underpay",
        errorCode: "UNDERPAY" as const,
      };
    }
    if (paymentProof.settlement === "transfer") {
      if (!paymentProof.txSignature.startsWith("tx-ok-")) {
        return { ok: false, settledOnchain: false, error: "invalid proof", errorCode: "INVALID_PROOF" as const };
      }
      return { ok: true, settledOnchain: true, txSignature: paymentProof.txSignature };
    }
    if (paymentProof.settlement === "stream") {
      if (!paymentProof.streamId.startsWith("stream-ok-")) {
        return { ok: false, settledOnchain: false, error: "invalid proof", errorCode: "INVALID_PROOF" as const };
      }
      return { ok: true, settledOnchain: true, streamId: paymentProof.streamId };
    }
    if (paymentProof.settlement === "netting") {
      return { ok: true, settledOnchain: false };
    }
    return { ok: false, settledOnchain: false, error: "unsupported" };
  }
}

function config(overrides: Partial<X402Config> = {}): X402Config {
  return {
    port: 0,
    appVersion: "programmable-payments-test",
    solanaRpcUrl: "https://api.devnet.solana.com",
    usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    paymentRecipient: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
    defaultCurrency: "USDC",
    enabledPricingModels: ["flat", "surge", "stream"],
    marketplaceSelection: "cheapest_sla_else_limit_order",
    quoteTtlSeconds: 2,
    feePolicy: {
      baseFeeAtomic: 0n,
      feeBps: 0,
      minFeeAtomic: 0n,
      accrueThresholdAtomic: 100n,
      minSettleAtomic: 0n,
    },
    nettingThresholdAtomic: 1_000n,
    nettingIntervalMs: 1_000,
    pauseMarket: false,
    pauseFinalize: false,
    pauseOrders: false,
    disabledShops: [],
    autoDisableReportThreshold: 0,
    unsafeUnverifiedNettingEnabled: false,
    allowInsecure: true,
    ...overrides,
  };
}

async function quoteAndCommit(app: ReturnType<typeof createX402App>["app"], resource = "/resource") {
  const quoteRes = await request(app).get("/quote").query({ resource }).expect(200);
  const quoteId = quoteRes.body.quoteId as string;
  const commitRes = await request(app)
    .post("/commit")
    .send({ quoteId, payerCommitment32B: "0x" + "ab".repeat(32) })
    .expect(201);
  return {
    quote: quoteRes.body as { quoteId: string; totalAtomic: string },
    commitId: commitRes.body.commitId as string,
  };
}

describe("programmable payments attack matrix", () => {
  it("keeps the local primitive set broad enough for the product pitch", () => {
    const ids = new Set(PROGRAMMABILITY_FIXTURES.map((fixture) => fixture.id));
    expect(ids).toEqual(new Set([
      "fixed_price_tool",
      "usage_metered_tool",
      "surge_priced_tool",
      "english_auction",
      "dutch_auction",
      "sealed_bid_commit_reveal",
      "prediction_market_binary",
      "reverse_auction",
      "subscription_stream_gate",
      "bundle_reseller_margin",
    ]));

    for (const fixture of PROGRAMMABILITY_FIXTURES) {
      expect(fixture.resourcePath).toMatch(/^\/programmability\//);
      expect(fixture.capabilityTags).toContain("programmable");
    }
  });

  it("fails closed for underpay, unsupported settlement, expired quote, and stream replay", async () => {
    let nowMs = Date.parse("2026-05-15T00:00:00.000Z");
    const { app } = createX402App(config(), {
      now: () => new Date(nowMs),
      paymentVerifier: new StrictVerifier(),
      receiptSigner: ReceiptSigner.generate(),
    });

    const underpay = await quoteAndCommit(app);
    const underpayRes = await request(app)
      .post("/finalize")
      .send({
        commitId: underpay.commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-underpay-123456789012345678901234567890",
          amountAtomic: (BigInt(underpay.quote.totalAtomic) - 1n).toString(),
        },
      })
      .expect(402);
    expect(underpayRes.body.error.code).toBe("X402_UNDERPAY");

    const unsupported = await quoteAndCommit(app);
    await request(app)
      .post("/finalize")
      .send({
        commitId: unsupported.commitId,
        paymentProof: {
          settlement: "netting",
          amountAtomic: unsupported.quote.totalAtomic,
        },
      })
      .expect(400);

    const expired = await quoteAndCommit(app);
    nowMs += 3_000;
    await request(app)
      .post("/finalize")
      .send({
        commitId: expired.commitId,
        paymentProof: {
          settlement: "transfer",
          txSignature: "tx-ok-expired-123456789012345678901234567890",
          amountAtomic: expired.quote.totalAtomic,
        },
      })
      .expect(410);

    nowMs = Date.parse("2026-05-15T00:00:10.000Z");
    const firstStream = await quoteAndCommit(app, "/stream-access");
    await request(app)
      .post("/finalize")
      .send({
        commitId: firstStream.commitId,
        paymentProof: {
          settlement: "stream",
          streamId: "stream-ok-replay-same-id",
          amountAtomic: firstStream.quote.totalAtomic,
        },
      })
      .expect(200);

    const secondStream = await quoteAndCommit(app, "/stream-access");
    const replay = await request(app)
      .post("/finalize")
      .send({
        commitId: secondStream.commitId,
        paymentProof: {
          settlement: "stream",
          streamId: "stream-ok-replay-same-id",
          amountAtomic: secondStream.quote.totalAtomic,
        },
      })
      .expect(409);
    expect(replay.body.error.code).toBe("X402_REPLAY_DETECTED");
  });
});
