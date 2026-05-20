import request from "supertest";
import { describe, expect, it } from "vitest";
import { X402Config } from "../src/config.js";
import { ReceiptSigner } from "../src/receipts.js";
import { createX402App } from "../src/server.js";

const baseConfig: X402Config = {
  port: 8080,
  appVersion: "polymarket-live-routes-test",
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
};

function makeApp() {
  return createX402App(baseConfig, {
    receiptSigner: ReceiptSigner.generate(),
  });
}

describe("polymarket live route aliases", () => {
  it("serves readiness on both /api and /v1 paths", async () => {
    const { app } = makeApp();

    const apiReadiness = await request(app)
      .get("/api/polymarket/live/readiness")
      .expect(200);
    expect(apiReadiness.body.ok).toBe(true);
    expect(apiReadiness.body).toHaveProperty("builderCredentialsReady");

    const v1Readiness = await request(app)
      .get("/v1/polymarket/live/readiness")
      .expect(200);
    expect(v1Readiness.body.ok).toBe(true);
    expect(v1Readiness.body).toHaveProperty("builderCredentialsReady");
  });

  it("serves order-precheck on both /api and /v1 paths", async () => {
    const { app } = makeApp();

    await request(app)
      .post("/api/polymarket/live/order-precheck")
      .send({})
      .expect(400)
      .expect((res) => {
        expect(res.body.error).toBe("invalid_polymarket_order_precheck");
      });

    await request(app)
      .post("/v1/polymarket/live/order-precheck")
      .send({})
      .expect(400)
      .expect((res) => {
        expect(res.body.error).toBe("invalid_polymarket_order_precheck");
      });
  });

  it("keeps live submit closed when polymarket live gate is disabled", async () => {
    const { app } = makeApp();

    await request(app)
      .post("/api/polymarket/live/submit")
      .send({})
      .expect(403)
      .expect((res) => {
        expect(res.body.error).toBe("POLYMARKET_LIVE_GATE_CLOSED");
      });

    await request(app)
      .post("/v1/polymarket/live/submit")
      .send({})
      .expect(403)
      .expect((res) => {
        expect(res.body.error).toBe("POLYMARKET_LIVE_GATE_CLOSED");
      });
  });
});
