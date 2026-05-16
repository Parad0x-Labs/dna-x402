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
    return { ok: false, settledOnchain: false, error: "unsupported" };
  }
}

const baseConfig: X402Config = {
  port: 8080,
  appVersion: "admin-hardening-test",
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

function app() {
  return createX402App(baseConfig, {
    paymentVerifier: new FakeVerifier(),
    receiptSigner: ReceiptSigner.generate(),
  });
}

describe("x402 admin hardening surfaces", () => {
  it("blocks non-admin access to policy and emergency pages", async () => {
    const created = app();
    await request(created.app).get("/admin/x402/policy").expect(403);
    await request(created.app).get("/admin/x402/emergency").expect(403);
    clearInterval(created.context.market.orderPollTimer);
  });

  it("rejects denylist entries without evidence and audits valid emergency pause", async () => {
    const created = app();
    try {
      const token = baseConfig.adminSecret as string;
      await request(created.app)
        .post("/admin/x402/denylist")
        .set("x-admin-token", token)
        .send({
          subjectType: "LISTING",
          subjectValue: "bad-listing",
          reasonCode: "restricted",
          evidenceRefs: [],
          severity: "HIGH",
          createdBy: "sls_0x",
        })
        .expect(400);

      await request(created.app)
        .post("/admin/x402/emergency")
        .set("x-admin-token", token)
        .send({ flag: "quotePaused", enabled: true, actorId: "sls_0x" })
        .expect(400);

      const pause = await request(created.app)
        .post("/admin/x402/emergency")
        .set("x-admin-token", token)
        .send({
          flag: "quotePaused",
          enabled: true,
          reason: "incident drill",
          actorId: "sls_0x",
        })
        .expect(200);
      expect(pause.body.state.quotePaused).toBe(true);

      await request(created.app).get("/quote").query({ resource: "/resource" }).expect(503);

      const audit = await request(created.app)
        .get("/admin/x402/audit")
        .set("x-admin-token", token)
        .query({ kind: "PAUSE_ACTIVATED" })
        .expect(200);
      expect(audit.body.entries.length).toBeGreaterThan(0);
    } finally {
      clearInterval(created.context.market.orderPollTimer);
    }
  });

  it("appeal approval is available only through the audited admin path", async () => {
    const created = app();
    try {
      const token = baseConfig.adminSecret as string;
      const opened = await request(created.app)
        .post("/admin/x402/appeals")
        .set("x-admin-token", token)
        .send({
          subjectType: "LISTING",
          subjectId: "listing-1",
          policyDecisionId: "decision-1",
          reason: "false positive",
          evidenceRefs: ["ticket-1"],
        })
        .expect(201);

      const resolved = await request(created.app)
        .post(`/admin/x402/appeals/${opened.body.appeal.appealId}/resolve`)
        .set("x-admin-token", token)
        .send({
          approved: true,
          reviewer: "sls_0x",
          resolutionReason: "evidence accepted",
        })
        .expect(200);

      expect(resolved.body.appeal.status).toBe("APPROVED");
      const audit = await request(created.app)
        .get("/admin/x402/audit")
        .set("x-admin-token", token)
        .query({ kind: "GOVERNANCE_ACTION" })
        .expect(200);
      expect(audit.body.entries.some((entry: any) => entry.meta?.action === "appeal.resolve")).toBe(true);
    } finally {
      clearInterval(created.context.market.orderPollTimer);
    }
  });
});
