import assert from "node:assert/strict";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import bs58 from "bs58";
import request from "supertest";
import nacl from "tweetnacl";
import { X402Config, runtimeGatesForConfig } from "../../src/config.js";
import { BundleRegistry } from "../../src/market/bundles.js";
import { createSignedManifest } from "../../src/market/manifest.js";
import { ShopManifest, SignedShopManifest } from "../../src/market/types.js";
import { PaymentVerifier } from "../../src/paymentVerifier.js";
import { ReceiptSigner } from "../../src/receipts.js";
import { createX402App } from "../../src/server.js";
import { PaymentProof, Quote } from "../../src/types.js";
import { assertNoBundleCycle, sealedBidHash, trustedExternalVolume, verifySealedBidReveal } from "../../src/economics/abuse.js";
import { MarketEventPrivacyService } from "../../src/eventPrivacy/access.js";
import { signWebhookPayload } from "../../src/webhooks/signed.js";
import { buildFeeWaterfallV2, validateSplitFinalizeRequest } from "../../src/fees/waterfall.js";

export interface ServerMayhemResult {
  name: string;
  ok: boolean;
  detail: string;
}

const BASE_CONFIG: X402Config = {
  port: 8080,
  appVersion: "mayhem-server",
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
  allowInsecure: false,
  adminSecret: "mayhem-admin-secret",
  publicBeta: {
    enabled: true,
    gateRef: "PUBLIC_BETA_AGENT_PILOT_MAYHEM",
    agentCreation: true,
    paperAgents: true,
    publicAgentProfiles: true,
    copySettings: true,
    alphaMonetization: true,
    liveLowRisk: false,
    requireClientSignature: true,
    backendSigning: false,
    backendCustody: false,
    maxTxUsd: 200,
    maxDailySpendUsd: 1500,
    maxDailyLossUsd: 300,
    maxOpenExposureUsd: 500,
  },
};

class MayhemVerifier implements PaymentVerifier {
  async verify(quote: Quote, paymentProof: PaymentProof) {
    if (paymentProof.settlement === "stream") {
      if (!paymentProof.streamId) {
        return { ok: false, settledOnchain: false, errorCode: "INVALID_PROOF" as const, error: "missing stream id" };
      }
      return { ok: true, settledOnchain: false, streamId: paymentProof.streamId };
    }

    if (paymentProof.settlement !== "transfer") {
      return { ok: false, settledOnchain: false, errorCode: "INVALID_PROOF" as const, error: "unsupported fake proof" };
    }

    const sig = paymentProof.txSignature ?? "";
    if (paymentProof.amountAtomic && BigInt(paymentProof.amountAtomic) < BigInt(quote.totalAtomic)) {
      return { ok: false, settledOnchain: false, errorCode: "UNDERPAY" as const, error: "underpay" };
    }
    if (sig.startsWith("tx-ok-")) {
      return { ok: true, settledOnchain: true, txSignature: sig };
    }
    if (sig.startsWith("tx-underpay-")) {
      return { ok: false, settledOnchain: false, errorCode: "UNDERPAY" as const, error: "underpay" };
    }
    if (sig.startsWith("tx-wrong-mint-")) {
      return { ok: false, settledOnchain: false, errorCode: "WRONG_MINT" as const, error: "wrong mint" };
    }
    if (sig.startsWith("tx-wrong-recipient-")) {
      return { ok: false, settledOnchain: false, errorCode: "WRONG_RECIPIENT" as const, error: "wrong recipient" };
    }
    return { ok: false, settledOnchain: false, errorCode: "INVALID_PROOF" as const, error: "invalid proof" };
  }
}

function makeApp(overrides: Partial<X402Config> = {}, options: { now?: () => Date; bundles?: BundleRegistry } = {}) {
  return createX402App({ ...BASE_CONFIG, ...overrides }, {
    paymentVerifier: new MayhemVerifier(),
    receiptSigner: ReceiptSigner.generate(),
    now: options.now,
    bundles: options.bundles,
  });
}

function stopApp(app: ReturnType<typeof makeApp>): void {
  if (app.context.market.orderPollTimer) {
    clearInterval(app.context.market.orderPollTimer);
  }
}

function signedShop(input: {
  shopId: string;
  category?: string;
  capability?: string;
  path?: string;
  settlementModes?: ShopManifest["endpoints"][number]["settlementModes"];
}): SignedShopManifest {
  const kp = nacl.sign.keyPair();
  const ownerPubkey = bs58.encode(kp.publicKey);
  const ownerSecret = bs58.encode(kp.secretKey);
  const manifest: ShopManifest = {
    manifestVersion: "market-v1",
    shopId: input.shopId,
    name: `${input.shopId} Shop`,
    description: `${input.shopId} mayhem shop`,
    category: input.category ?? "ai_inference",
    ownerPubkey,
    endpoints: [
      {
        endpointId: `${input.shopId}-endpoint`,
        method: "POST",
        path: input.path ?? "/tool",
        capabilityTags: [input.capability ?? "data"],
        description: "mayhem endpoint",
        pricingModel: { kind: "flat", amountAtomic: "1000" },
        settlementModes: input.settlementModes ?? ["transfer", "stream"],
        sla: { maxLatencyMs: 1200, availabilityTarget: 0.995 },
      },
    ],
  };
  return createSignedManifest(manifest, ownerSecret);
}

async function expectSafe(name: string, fn: () => Promise<void>): Promise<ServerMayhemResult> {
  try {
    await fn();
    return { name, ok: true, detail: "safe" };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function quoteAndCommit(app: ReturnType<typeof makeApp>, amountAtomic = "100") {
  const quote = await request(app.app)
    .get("/quote")
    .query({ resource: "/resource", amountAtomic })
    .expect(200);
  const commit = await request(app.app)
    .post("/commit")
    .send({ quoteId: quote.body.quoteId, payerCommitment32B: `0x${"11".repeat(32)}` })
    .expect(201);
  return { quoteId: quote.body.quoteId as string, commitId: commit.body.commitId as string };
}

async function finalizedReceipt(app: ReturnType<typeof makeApp>) {
  const { commitId } = await quoteAndCommit(app);
  const finalized = await request(app.app)
    .post("/finalize")
    .send({ commitId, paymentProof: { settlement: "transfer", txSignature: `tx-ok-${cryptoRandomSuffix()}` } })
    .expect(200);
  return { commitId, receiptId: finalized.body.receiptId as string };
}

function cryptoRandomSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-123456789012345678901234`;
}

function webhookEnvelope(secret: string, input: {
  idempotencyKey: string;
  event: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}) {
  return signWebhookPayload(secret, {
    idempotencyKey: input.idempotencyKey,
    event: input.event,
    timestamp: input.timestamp ?? new Date().toISOString(),
    payload: input.payload ?? { ok: true },
  });
}

function rawSignedWebhookEnvelope(secret: string, input: {
  idempotencyKey: string;
  event: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}) {
  const payload = {
    idempotencyKey: input.idempotencyKey,
    event: input.event,
    timestamp: input.timestamp ?? new Date().toISOString(),
    payload: input.payload ?? { ok: true },
  };
  const signature = crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
  return { ...payload, signature };
}

function webhookReceiverGates() {
  return {
    ...runtimeGatesForConfig(BASE_CONFIG),
    webhookReceiverTest: true,
    prodMoney: false,
  };
}

export async function runServerMayhem(): Promise<ServerMayhemResult[]> {
  const results: ServerMayhemResult[] = [];

  results.push(await expectSafe("underpay rejected at finalize", async () => {
    const app = makeApp();
    try {
      const { commitId } = await quoteAndCommit(app);
      const res = await request(app.app)
        .post("/finalize")
        .send({ commitId, paymentProof: { settlement: "transfer", txSignature: "tx-underpay-123456789012345678901234" } })
        .expect(402);
      assert.equal(res.body.error.code, "X402_UNDERPAY");
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("wrong mint rejected at finalize", async () => {
    const app = makeApp();
    try {
      const { commitId } = await quoteAndCommit(app);
      const res = await request(app.app)
        .post("/finalize")
        .send({ commitId, paymentProof: { settlement: "transfer", txSignature: "tx-wrong-mint-123456789012345678901234" } })
        .expect(402);
      assert.equal(res.body.error.code, "X402_WRONG_MINT");
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("wrong recipient rejected at finalize", async () => {
    const app = makeApp();
    try {
      const { commitId } = await quoteAndCommit(app);
      const res = await request(app.app)
        .post("/finalize")
        .send({ commitId, paymentProof: { settlement: "transfer", txSignature: "tx-wrong-recipient-123456789012345678901234" } })
        .expect(402);
      assert.equal(res.body.error.code, "X402_WRONG_RECIPIENT");
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("expired quote rejected at commit and finalize", async () => {
    let nowMs = Date.parse("2026-05-15T00:00:00.000Z");
    const app = makeApp({ quoteTtlSeconds: 1 }, { now: () => new Date(nowMs) });
    try {
      const quote = await request(app.app).get("/quote").query({ resource: "/resource", amountAtomic: "100" }).expect(200);
      const commit = await request(app.app)
        .post("/commit")
        .send({ quoteId: quote.body.quoteId, payerCommitment32B: `0x${"23".repeat(32)}` })
        .expect(201);
      nowMs += 2_000;
      await request(app.app)
        .post("/commit")
        .send({ quoteId: quote.body.quoteId, payerCommitment32B: `0x${"22".repeat(32)}` })
        .expect(410);
      await request(app.app)
        .post("/finalize")
        .send({ commitId: commit.body.commitId, paymentProof: { settlement: "transfer", txSignature: "tx-ok-expired-123456789012345678901234" } })
        .expect(410);
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("unsupported settlement rejected at finalize", async () => {
    const app = makeApp();
    try {
      const { commitId } = await quoteAndCommit(app);
      await request(app.app)
        .post("/finalize")
        .send({ commitId, paymentProof: { settlement: "netting" } })
        .expect(400);
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("payment proof without commit rejected", async () => {
    const app = makeApp();
    try {
      await request(app.app)
        .post("/finalize")
        .send({ commitId: "00000000-0000-4000-8000-000000000001", paymentProof: { settlement: "transfer", txSignature: "tx-ok-missing-123456789012345678901234" } })
        .expect(404);
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("payment proof for different quote rejected by global tx replay", async () => {
    const app = makeApp();
    try {
      const first = await quoteAndCommit(app, "100");
      const second = await quoteAndCommit(app, "200");
      const txSignature = "tx-ok-differentQuoteReplayABCDEFGH123456789012345";
      await request(app.app)
        .post("/finalize")
        .send({ commitId: first.commitId, paymentProof: { settlement: "transfer", txSignature } })
        .expect(200);
      const replay = await request(app.app)
        .post("/finalize")
        .send({ commitId: second.commitId, paymentProof: { settlement: "transfer", txSignature } })
        .expect(409);
      assert.equal(replay.body.error.code, "X402_REPLAY_DETECTED");
      assert.equal(app.context.receipts.size, 1);
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("stream reuse rejected", async () => {
    const app = makeApp();
    try {
      const first = await quoteAndCommit(app);
      const second = await quoteAndCommit(app);
      await request(app.app)
        .post("/finalize")
        .send({ commitId: first.commitId, paymentProof: { settlement: "stream", streamId: "stream-reuse-1" } })
        .expect(200);
      const replay = await request(app.app)
        .post("/finalize")
        .send({ commitId: second.commitId, paymentProof: { settlement: "stream", streamId: "stream-reuse-1" } })
        .expect(409);
      assert.equal(replay.body.error.code, "X402_REPLAY_DETECTED");
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("concurrent replay allows only one success", async () => {
    const app = makeApp();
    try {
      const first = await quoteAndCommit(app);
      const second = await quoteAndCommit(app);
      const txSignature = "tx-ok-concurrentReplayABCDEFGH12345678901234567890";
      const responses = await Promise.all([
        request(app.app).post("/finalize").send({ commitId: first.commitId, paymentProof: { settlement: "transfer", txSignature } }),
        request(app.app).post("/finalize").send({ commitId: second.commitId, paymentProof: { settlement: "transfer", txSignature } }),
      ]);
      const successes = responses.filter((res) => res.status === 200).length;
      const replays = responses.filter((res) => res.status === 409 && res.body.error?.code === "X402_REPLAY_DETECTED").length;
      const statusDetail = responses.map((res) => `${res.status}:${JSON.stringify(res.body).slice(0, 120)}`).join(" | ");
      assert.equal(successes, 1, statusDetail);
      assert.equal(replays, 1, statusDetail);
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("commit reuse is idempotent and creates no second receipt", async () => {
    const app = makeApp();
    try {
      const { commitId } = await quoteAndCommit(app);
      const first = await request(app.app)
        .post("/finalize")
        .send({ commitId, paymentProof: { settlement: "transfer", txSignature: "tx-ok-commit-reuse-123456789012345678901234" } })
        .expect(200);
      const second = await request(app.app)
        .post("/finalize")
        .send({ commitId, paymentProof: { settlement: "transfer", txSignature: "tx-ok-commit-reuse-different-123456789012345678901234" } })
        .expect(200);
      assert.equal(first.body.receiptId, second.body.receiptId);
      assert.equal(app.context.receipts.size, 1);
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("response swap blocked by paid retry consumption", async () => {
    const app = makeApp();
    try {
      const { commitId } = await finalizedReceipt(app);
      await request(app.app).get("/resource").set("x-dnp-commit-id", commitId).expect(200);
      await request(app.app).get("/resource").set("x-dnp-commit-id", commitId).expect(402);
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("restricted listing cannot publish", async () => {
    const app = makeApp();
    try {
      const res = await request(app.app).post("/market/shops").send(signedShop({
        shopId: "restricted",
        category: "gambling",
        capability: "sports_betting",
      })).expect(422);
      assert.match(JSON.stringify(res.body), /POLICY/);
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("restricted quote rejected after unsafe direct registry insert", async () => {
    const app = makeApp();
    try {
      app.context.market.registry.register(signedShop({
        shopId: "unsafe-bypass",
        category: "workflow_tool",
        capability: "sports_betting",
      }));
      const quotes = await request(app.app)
        .get("/market/quotes")
        .query({ capability: "sports_betting", limit: 10 })
        .expect(200);
      assert.equal(quotes.body.quotes.length, 0);
      assert(app.context.market.policyAuditEvents.some((event) => event.reasonCodes.includes("BLOCK_RESTRICTED_CAPABILITY")));
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("high-risk and public physical goods categories stay blocked", async () => {
    const app = makeApp();
    try {
      await request(app.app).post("/market/shops").send(signedShop({
        shopId: "high-risk-category",
        category: "regulated_goods",
        capability: "data",
      })).expect(422);
      await request(app.app).post("/market/shops").send(signedShop({
        shopId: "physical-public",
        category: "physical_goods_public",
        capability: "data",
      })).expect(422);
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("risky listing routes to review or block", async () => {
    const app = makeApp();
    try {
      const res = await request(app.app).post("/market/shops").send(signedShop({
        shopId: "regulated",
        category: "workflow_tool",
        capability: "wager",
      })).expect(422);
      assert.match(JSON.stringify(res.body), /POLICY/);
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("disabled listing cannot quote", async () => {
    const app = makeApp({ disabledShops: ["disabled-shop"] });
    try {
      await request(app.app).post("/market/shops").send(signedShop({ shopId: "disabled-shop" })).expect(423);
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("admin disable and restore are audited", async () => {
    const app = makeApp();
    try {
      await request(app.app).post("/market/shops").send(signedShop({ shopId: "admin-toggle" })).expect(201);
      await request(app.app)
        .post("/admin/market/shops/admin-toggle/disable")
        .set("x-admin-token", "mayhem-admin-secret")
        .send({ actorId: "operator-1" })
        .expect(200);
      await request(app.app).get("/market/shops/admin-toggle").expect(423);
      await request(app.app)
        .post("/admin/market/shops/admin-toggle/restore")
        .set("x-admin-token", "mayhem-admin-secret")
        .send({ actorId: "operator-1", reason: "mayhem restore" })
        .expect(200);
      await request(app.app).get("/market/shops/admin-toggle").expect(200);
      const audit = app.context.auditLog.query({ limit: 100 });
      assert(audit.some((entry) => entry.kind === "SHOP_DISABLED" && entry.shopId === "admin-toggle"));
      assert(audit.some((entry) => entry.kind === "ADMIN_ACTION" && entry.meta?.action === "listing.restore"));
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("emergency marketplace pause blocks publish and quote", async () => {
    const app = makeApp({ pauseMarket: true });
    try {
      await request(app.app).post("/market/shops").send(signedShop({ shopId: "paused-shop" })).expect(503);
      await request(app.app).get("/market/quotes").expect(503);
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("finalize pause blocks finalize only and receipts remain readable", async () => {
    const live = makeApp();
    try {
      const { receiptId } = await finalizedReceipt(live);
      await request(live.app).get(`/receipt/${receiptId}`).expect(200);
    } finally {
      stopApp(live);
    }

    const paused = makeApp({ pauseFinalize: true });
    try {
      const { commitId } = await quoteAndCommit(paused);
      const res = await request(paused.app)
        .post("/finalize")
        .send({ commitId, paymentProof: { settlement: "transfer", txSignature: "tx-ok-paused-123456789012345678901234" } })
        .expect(503);
      assert.equal(res.body.error.code, "X402_PAUSED");
    } finally {
      stopApp(paused);
    }
  }));

  results.push(await expectSafe("metrics endpoint exposes production alert counters", async () => {
    const app = makeApp();
    try {
      const { receiptId } = await finalizedReceipt(app);
      await request(app.app).get(`/receipt/${receiptId}`).expect(200);
      const metrics = await request(app.app).get("/metrics").expect(200);
      assert.match(metrics.text, /x402_finalize_success_total/);
      assert.match(metrics.text, /x402_emergency_pause_active/);
      assert.match(metrics.text, /x402_pii_blocks_total/);
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("builder fee visible in quote and receipt-bound on finalize", async () => {
    const app = makeApp({
      builderMonetization: {
        platformFeeBps: 10,
        platformFeeMode: "seller_accrual",
        platformTreasury: "dna-treasury",
        builderFeesEnabled: true,
        builderFeeDefaultMode: "builder_accrual",
        builderFeeMaxBps: 500,
        affiliateFeesEnabled: false,
        affiliateFeeMaxBps: 200,
        directSplitFeesEnabled: false,
        autoSweepRequested: false,
      },
    });
    try {
      const quote = await request(app.app)
        .get("/quote")
        .query({
          resource: "/resource",
          amountAtomic: "100000",
          builderId: "builder-mayhem",
          builderFeeBps: "50",
          builderRecipient: "builder-treasury",
          builderFeeMode: "builder_accrual",
        })
        .expect(200);
      assert.equal(quote.body.feeWaterfallV2.version, "fee_waterfall_v2");
      assert(quote.body.feeWaterfallV2.lines.some((line: any) => line.kind === "DNA_PLATFORM_FEE"));
      assert(quote.body.feeWaterfallV2.lines.some((line: any) => line.kind === "BUILDER_FEE"));
      const commit = await request(app.app)
        .post("/commit")
        .send({ quoteId: quote.body.quoteId, payerCommitment32B: `0x${"44".repeat(32)}` })
        .expect(201);
      const finalized = await request(app.app)
        .post("/finalize")
        .send({ commitId: commit.body.commitId, paymentProof: { settlement: "transfer", txSignature: "tx-ok-builder-fee-123456789012345678901234" } })
        .expect(200);
      assert(finalized.body.feeAccruals.some((item: any) => item.feeKind === "DNA_PLATFORM_FEE"));
      assert(finalized.body.feeAccruals.some((item: any) => item.feeKind === "BUILDER_FEE"));
      const receipt = await request(app.app).get(`/receipt/${finalized.body.receiptId}`).expect(200);
      assert.equal(receipt.body.payload.feeWaterfallHash, quote.body.feeWaterfallV2.feeWaterfallHash);
      assert.equal(receipt.body.payload.feeCollectionSummary.builderFeeStatus, "ACCRUED_NOT_COLLECTED");
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("builder fee hidden attempt, cap violation, suspension, and DNA override fail safely", async () => {
    const app = makeApp({
      builderMonetization: {
        platformFeeBps: 10,
        platformFeeMode: "display_only",
        platformTreasury: "dna-treasury",
        builderFeesEnabled: true,
        builderFeeDefaultMode: "display_only",
        builderFeeMaxBps: 500,
        affiliateFeesEnabled: false,
        affiliateFeeMaxBps: 200,
        directSplitFeesEnabled: false,
        autoSweepRequested: false,
      },
    });
    try {
      await request(app.app).get("/quote").query({
        amountAtomic: "100000",
        builderId: "hidden",
        builderFeeBps: "50",
        builderRecipient: "builder",
        builderFeeHidden: "true",
      }).expect(422);
      await request(app.app).get("/quote").query({
        amountAtomic: "100000",
        builderId: "cap",
        builderFeeBps: "501",
        builderRecipient: "builder",
      }).expect(422);
      await request(app.app).get("/quote").query({
        amountAtomic: "100000",
        builderId: "suspended",
        builderFeeBps: "50",
        builderRecipient: "builder",
        builderStatus: "SUSPENDED",
      }).expect(422);
      const safe = await request(app.app).get("/quote").query({
        amountAtomic: "100000",
        builderId: "safe",
        builderFeeBps: "50",
        builderRecipient: "builder",
      }).expect(200);
      assert(safe.body.feeWaterfallV2.lines.some((line: any) => line.kind === "DNA_PLATFORM_FEE"));
      assert(safe.body.feeWaterfallV2.lines.some((line: any) => line.kind === "BUILDER_FEE"));
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("direct split missing proofs, wrong builder recipient, replay, and tamper fail safely", async () => {
    const waterfall = buildFeeWaterfallV2({
      quoteId: "mayhem-split",
      grossAmount: "100000",
      token: "USDC",
      decimals: 6,
      providerRecipient: "seller",
      platformFeeBps: 10,
      platformRecipient: "dna",
      platformMode: "direct_split",
      builderProfile: {
        builderId: "builder-direct",
        displayName: "Builder Direct",
        slug: "builder-direct",
        ownerWallet: "owner",
        treasuryWallet: "builder",
        verifiedStatus: "ADMIN_VERIFIED",
        allowedFeeBpsMax: 500,
        defaultFeeBps: 50,
        status: "ACTIVE",
        policyStrikeCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      builderFee: {
        builderId: "builder-direct",
        enabled: true,
        feeBps: 50,
        recipient: "builder",
        token: "USDC",
        mode: "direct_split",
        refundBehavior: "REFUND_PRO_RATA",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      directSplitEnabled: true,
      noDoubleChargeScope: "mayhem-split",
    });
    assert.throws(() => validateSplitFinalizeRequest({
      waterfall,
      request: { quoteId: "mayhem-split", commitId: "commit", proofs: [] },
      chain: "solana",
      directSplitEnabled: false,
      proofResults: [],
    }), /direct split fee gate disabled/);
    const lines = waterfall.lines.filter((line) => line.requiredForFinalize && line.recipient);
    assert.throws(() => validateSplitFinalizeRequest({
      waterfall,
      request: { quoteId: "mayhem-split", commitId: "commit", proofs: [] },
      chain: "solana",
      directSplitEnabled: true,
      gateRef: "gate",
      proofResults: lines.filter((line) => line.kind !== "DNA_PLATFORM_FEE").map((line) => ({
        feeLineId: line.id,
        chain: "solana",
        token: "USDC",
        recipient: line.recipient!,
        amount: line.amount,
        quoteId: "mayhem-split",
      })),
    }), /missing DNA_PLATFORM_FEE proof/);
    assert.throws(() => validateSplitFinalizeRequest({
      waterfall,
      request: { quoteId: "mayhem-split", commitId: "commit", proofs: [] },
      chain: "solana",
      directSplitEnabled: true,
      gateRef: "gate",
      proofResults: lines.map((line) => ({
        feeLineId: line.id,
        chain: "solana",
        token: "USDC",
        recipient: line.kind === "BUILDER_FEE" ? "attacker" : line.recipient!,
        amount: line.amount,
        quoteId: "mayhem-split",
      })),
    }), /wrong recipient/);
    assert.throws(() => validateSplitFinalizeRequest({
      waterfall,
      request: { quoteId: "different", commitId: "commit", proofs: [] },
      chain: "solana",
      directSplitEnabled: true,
      gateRef: "gate",
      proofResults: [],
    }), /different quote/);
  }));

  results.push(await expectSafe("server direct split requires provider and DNA proofs and rejects treasury abuse", async () => {
    const app = makeApp({
      feePolicy: {
        ...BASE_CONFIG.feePolicy,
        feeBps: 0,
        baseFeeAtomic: 0n,
        minFeeAtomic: 0n,
      },
      builderMonetization: {
        platformFeeBps: 10,
        platformFeeMode: "direct_split",
        platformTreasury: "dna-treasury-mayhem",
        builderFeesEnabled: true,
        builderFeeDefaultMode: "display_only",
        builderFeeMaxBps: 500,
        affiliateFeesEnabled: false,
        affiliateFeeMaxBps: 200,
        directSplitFeesEnabled: true,
        directSplitGateRef: "mayhem-direct-split-gate",
        autoSweepRequested: false,
      },
    });
    try {
      const quote = await request(app.app)
        .get("/quote")
        .query({ resource: "/resource", amountAtomic: "1000000" })
        .expect(200);
      const lines = quote.body.feeWaterfallV2.lines.filter((line: any) => line.requiredForFinalize);
      const provider = lines.find((line: any) => line.kind === "PROVIDER_AMOUNT");
      const dna = lines.find((line: any) => line.kind === "DNA_PLATFORM_FEE");
      assert.equal(provider.amount, "999000");
      assert.equal(dna.amount, "1000");
      assert.equal(dna.recipient, "dna-treasury-mayhem");

      const missingCommit = await request(app.app)
        .post("/commit")
        .send({ quoteId: quote.body.quoteId, payerCommitment32B: `0x${"88".repeat(32)}` })
        .expect(201);
      await request(app.app)
        .post("/finalize")
        .send({
          commitId: missingCommit.body.commitId,
          splitPaymentProofs: [
            {
              feeLineId: provider.id,
              paymentProof: { settlement: "transfer", txSignature: "tx-ok-direct-provider-missing-1234567890123", amountAtomic: provider.amount },
            },
          ],
        })
        .expect(402);

      const wrongCommit = await request(app.app)
        .post("/commit")
        .send({ quoteId: quote.body.quoteId, payerCommitment32B: `0x${"89".repeat(32)}` })
        .expect(201);
      await request(app.app)
        .post("/finalize")
        .send({
          commitId: wrongCommit.body.commitId,
          splitPaymentProofs: [
            {
              feeLineId: provider.id,
              paymentProof: { settlement: "transfer", txSignature: "tx-ok-direct-provider-wrong-123456789012345", amountAtomic: provider.amount },
            },
            {
              feeLineId: dna.id,
              paymentProof: { settlement: "transfer", txSignature: "tx-wrong-recipient-direct-dna-123456789012", amountAtomic: dna.amount },
            },
          ],
        })
        .expect(402);

      const okQuote = await request(app.app)
        .get("/quote")
        .query({ resource: "/resource", amountAtomic: "1000000" })
        .expect(200);
      const okLines = okQuote.body.feeWaterfallV2.lines.filter((line: any) => line.requiredForFinalize);
      const okProvider = okLines.find((line: any) => line.kind === "PROVIDER_AMOUNT");
      const okDna = okLines.find((line: any) => line.kind === "DNA_PLATFORM_FEE");
      const okCommit = await request(app.app)
        .post("/commit")
        .send({ quoteId: okQuote.body.quoteId, payerCommitment32B: `0x${"90".repeat(32)}` })
        .expect(201);
      const finalized = await request(app.app)
        .post("/finalize")
        .send({
          commitId: okCommit.body.commitId,
          splitPaymentProofs: [
            {
              feeLineId: okProvider.id,
              paymentProof: { settlement: "transfer", txSignature: "tx-ok-direct-provider-final-123456789012345", amountAtomic: okProvider.amount },
            },
            {
              feeLineId: okDna.id,
              paymentProof: { settlement: "transfer", txSignature: "tx-ok-direct-dna-final-1234567890123456789", amountAtomic: okDna.amount },
            },
          ],
        })
        .expect(200);
      assert.equal(finalized.body.splitPaymentResults.length, 2);
      const receipt = await request(app.app).get(`/receipt/${finalized.body.receiptId}`).expect(200);
      assert.equal(receipt.body.payload.feeCollectionSummary.dnaPlatformFeeStatus, "COLLECTED_DIRECT_SPLIT");
      assert(receipt.body.payload.splitPaymentProofs.some((item: any) => item.kind === "DNA_PLATFORM_FEE"));
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("agent wallet custody attempts and backend signing path fail safely", async () => {
    const app = makeApp();
    try {
      await request(app.app)
        .post("/v1/agents/mayhem-agent/wallets/register")
        .send({
          ownerWallet: "mother-wallet",
          publicKey: "agent-public-key",
          chain: "SOLANA",
          metadata: { privateKey: "forbidden" },
        })
        .expect(400);
      await request(app.app).post("/v1/agents/mayhem-agent/wallets/sign").send({ tx: "unsigned" }).expect(404);
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("copy controls block unsafe copied actions", async () => {
    const app = makeApp();
    const sourceAction = (overrides: Record<string, unknown> = {}) => ({
      sourceActionId: `mayhem-source-${cryptoRandomSuffix()}`,
      sourceAgentId: "alpha-mayhem",
      actionType: "BUY",
      marketId: "mayhem-market",
      category: "prediction_research",
      side: "YES",
      entryPriceBps: 5000,
      sizeAtomic: "100000",
      ...overrides,
    });
    try {
      const settings = await request(app.app)
        .post("/v1/copy/settings")
        .send({
          copySettingsId: "mayhem-copy-settings",
          followerAgentId: "follower-mayhem",
          sourceAgentId: "alpha-mayhem",
          enabled: true,
          mode: "PAPER_COPY",
          copyBuys: true,
          copySells: false,
          copyExits: false,
          minEntryPriceBps: 4000,
          maxEntryPriceBps: 6000,
          maxBetSizeAtomic: "200000",
          maxDailySpendAtomic: "500000",
          maxOpenExposureAtomic: "300000",
          useSourceExitRules: false,
          customTakeProfitBps: 2000,
          customStopLossBps: 1000,
          requireApprovalAlways: false,
        })
        .expect(201);

      const highEntry = await request(app.app)
        .post("/v1/copy/decide")
        .send({ copySettingsId: settings.body.settings.copySettingsId, sourceAction: sourceAction({ entryPriceBps: 8000 }) })
        .expect(200);
      assert.equal(highEntry.body.decision.decision, "SKIP");
      assert(highEntry.body.decision.reasonCodes.includes("ENTRY_PRICE_ABOVE_MAX"));

      const sellDisabled = await request(app.app)
        .post("/v1/copy/decide")
        .send({ copySettingsId: settings.body.settings.copySettingsId, sourceAction: sourceAction({ actionType: "SELL" }) })
        .expect(200);
      assert(sellDisabled.body.decision.reasonCodes.includes("COPY_SELLS_DISABLED"));

      const overBet = await request(app.app)
        .post("/v1/copy/decide")
        .send({ copySettingsId: settings.body.settings.copySettingsId, sourceAction: sourceAction({ sizeAtomic: "250000" }) })
        .expect(200);
      assert(overBet.body.decision.reasonCodes.includes("MAX_BET_SIZE_EXCEEDED"));

      const liveGated = await request(app.app)
        .post("/v1/copy/settings")
        .send({
          copySettingsId: "mayhem-live-copy",
          followerAgentId: "follower-live-mayhem",
          sourceAgentId: "alpha-mayhem",
          enabled: true,
          mode: "AUTO_COPY_PUBLIC_BETA",
          copyBuys: true,
          copySells: true,
          copyExits: true,
          maxBetSizeAtomic: "200000",
          maxDailySpendAtomic: "500000",
          maxOpenExposureAtomic: "300000",
          useSourceExitRules: true,
          requireApprovalAlways: false,
        })
        .expect(201);
      const bypass = await request(app.app)
        .post("/v1/copy/decide")
        .send({ copySettingsId: liveGated.body.settings.copySettingsId, sourceAction: sourceAction() })
        .expect(200);
      assert.equal(bypass.body.decision.decision, "SKIP");
      assert(bypass.body.decision.reasonCodes.includes("LIVE_COPY_GATED"));
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("alpha fee abuse paths fail safely", async () => {
    const app = makeApp();
    const sourceAction = (id: string) => ({
      sourceActionId: id,
      sourceAgentId: "alpha-fee-mayhem",
      actionType: "BUY",
      marketId: "alpha-fee-market",
      category: "prediction_research",
      side: "YES",
      entryPriceBps: 5000,
      sizeAtomic: "100000",
    });
    try {
      await request(app.app)
        .post("/v1/agents/alpha-fee-mayhem/monetization")
        .send({ enabled: true, successFeeBps: 100, mode: "ACCRUAL" })
        .expect(200);
      const settings = await request(app.app)
        .post("/v1/copy/settings")
        .send({
          copySettingsId: "alpha-fee-settings",
          followerAgentId: "follower-alpha-fee",
          sourceAgentId: "alpha-fee-mayhem",
          enabled: true,
          mode: "PAPER_COPY",
          copyBuys: true,
          copySells: true,
          copyExits: true,
          maxBetSizeAtomic: "200000",
          maxDailySpendAtomic: "500000",
          maxOpenExposureAtomic: "300000",
          useSourceExitRules: true,
          requireApprovalAlways: false,
        })
        .expect(201);
      const first = await request(app.app)
        .post("/v1/copy/decide")
        .send({ copySettingsId: settings.body.settings.copySettingsId, sourceAction: sourceAction("alpha-fee-first"), createLot: true })
        .expect(200);
      assert.equal(first.body.copiedLot.alphaFeeBpsAtEntry, 100);
      await request(app.app)
        .post("/v1/agents/alpha-fee-mayhem/monetization")
        .send({ enabled: true, successFeeBps: 300, mode: "ACCRUAL" })
        .expect(200);
      const win = await request(app.app)
        .post(`/v1/copy/lots/${first.body.copiedLot.copiedLotId}/finalize`)
        .send({ realizedPnlAtomic: "100000", finalized: true })
        .expect(200);
      assert.equal(win.body.alphaFeeAccrual.feeBps, 100);
      assert.equal(win.body.alphaFeeAccrual.feeAmountAtomic, "1000");
      await request(app.app)
        .post(`/v1/copy/lots/${first.body.copiedLot.copiedLotId}/finalize`)
        .send({ realizedPnlAtomic: "100000", finalized: true })
        .expect(409);

      const loss = await request(app.app)
        .post("/v1/copy/decide")
        .send({ copySettingsId: settings.body.settings.copySettingsId, sourceAction: sourceAction("alpha-fee-loss"), createLot: true })
        .expect(200);
      const lossFinalize = await request(app.app)
        .post(`/v1/copy/lots/${loss.body.copiedLot.copiedLotId}/finalize`)
        .send({ realizedPnlAtomic: "-100000", finalized: true })
        .expect(200);
      assert.equal(lossFinalize.body.alphaFeeAccrual, undefined);

      const unrealized = await request(app.app)
        .post("/v1/copy/decide")
        .send({ copySettingsId: settings.body.settings.copySettingsId, sourceAction: sourceAction("alpha-fee-unrealized"), createLot: true })
        .expect(200);
      await request(app.app)
        .post(`/v1/copy/lots/${unrealized.body.copiedLot.copiedLotId}/finalize`)
        .send({ realizedPnlAtomic: "100000", finalized: false })
        .expect(422);
    } finally {
      stopApp(app);
    }
  }));

  if ((process.env.X402_REPOSITORY_MODE ?? "").toLowerCase() === "postgres" && process.env.X402_DATABASE_URL) {
    results.push(await expectSafe("Postgres-backed agent/copy abuse checks survive restart", async () => {
      const suffix = crypto.randomUUID();
      const sourceAgentId = `alpha-pg-mayhem-${suffix}`;
      const followerAgentId = `follower-pg-mayhem-${suffix}`;
      const copySettingsId = `copy-pg-mayhem-${suffix}`;
      const config: Partial<X402Config> = {
        databaseUrl: process.env.X402_DATABASE_URL,
        repositoryMode: "postgres",
      };
      const sourceAction = (id: string, overrides: Record<string, unknown> = {}) => ({
        sourceActionId: id,
        sourceAgentId,
        actionType: "BUY",
        marketId: `market-${suffix}`,
        category: "prediction_research",
        side: "YES",
        entryPriceBps: 5000,
        sizeAtomic: "100000",
        ...overrides,
      });

      const first = makeApp(config);
      let copiedLotId = "";
      try {
        await request(first.app)
          .post(`/v1/agents/${followerAgentId}/wallets/register`)
          .send({
            ownerWallet: `mother-${suffix}`,
            publicKey: `agent-wallet-${suffix}`,
            chain: "SOLANA",
            metadata: { privateKey: "forbidden" },
          })
          .expect(400);
        await request(first.app)
          .post(`/v1/agents/${followerAgentId}/wallets/register`)
          .send({
            ownerWallet: `mother-${suffix}`,
            publicKey: `agent-wallet-${suffix}`,
            chain: "SOLANA",
          })
          .expect(201);
        await request(first.app)
          .post(`/v1/agents/${sourceAgentId}/monetization`)
          .send({ enabled: true, successFeeBps: 100, mode: "ACCRUAL" })
          .expect(200);
        await request(first.app)
          .post("/v1/copy/settings")
          .send({
            copySettingsId,
            followerAgentId,
            sourceAgentId,
            enabled: true,
            mode: "PAPER_COPY",
            copyBuys: true,
            copySells: true,
            copyExits: true,
            minEntryPriceBps: 4000,
            maxEntryPriceBps: 6000,
            maxBetSizeAtomic: "200000",
            maxDailySpendAtomic: "500000",
            maxOpenExposureAtomic: "300000",
            useSourceExitRules: true,
            requireApprovalAlways: false,
          })
          .expect(201);
        const opened = await request(first.app)
          .post("/v1/copy/decide")
          .send({ copySettingsId, sourceAction: sourceAction(`source-open-${suffix}`), createLot: true })
          .expect(200);
        copiedLotId = opened.body.copiedLot.copiedLotId;
      } finally {
        stopApp(first);
      }

      const restarted = makeApp(config);
      try {
        const wallets = await request(restarted.app).get(`/v1/agents/${followerAgentId}/wallets`).expect(200);
        assert.equal(wallets.body.wallets[0].backendHasPrivateKey, false);

        const highEntry = await request(restarted.app)
          .post("/v1/copy/decide")
          .send({ copySettingsId, sourceAction: sourceAction(`source-high-${suffix}`, { entryPriceBps: 8000 }) })
          .expect(200);
        assert(highEntry.body.decision.reasonCodes.includes("ENTRY_PRICE_ABOVE_MAX"));

        const overDaily = await request(restarted.app)
          .post("/v1/copy/decide")
          .send({ copySettingsId, sourceAction: sourceAction(`source-daily-${suffix}`), currentDailySpendAtomic: "450001" })
          .expect(200);
        assert(overDaily.body.decision.reasonCodes.includes("MAX_DAILY_SPEND_EXCEEDED"));

        const paused = await request(restarted.app)
          .post("/v1/copy/decide")
          .send({ copySettingsId, sourceAction: sourceAction(`source-paused-${suffix}`), emergencyPaused: true })
          .expect(200);
        assert(paused.body.decision.reasonCodes.includes("EMERGENCY_PAUSED"));

        const win = await request(restarted.app)
          .post(`/v1/copy/lots/${copiedLotId}/finalize`)
          .send({ realizedPnlAtomic: "100000", finalized: true })
          .expect(200);
        assert.equal(win.body.alphaFeeAccrual.feeAmountAtomic, "1000");
      } finally {
        stopApp(restarted);
      }

      const finalRestart = makeApp(config);
      try {
        await request(finalRestart.app)
          .post(`/v1/copy/lots/${copiedLotId}/finalize`)
          .send({ realizedPnlAtomic: "100000", finalized: true })
          .expect(409);
        const loss = await request(finalRestart.app)
          .post("/v1/copy/decide")
          .send({ copySettingsId, sourceAction: sourceAction(`source-loss-${suffix}`), createLot: true })
          .expect(200);
        const closedLoss = await request(finalRestart.app)
          .post(`/v1/copy/lots/${loss.body.copiedLot.copiedLotId}/finalize`)
          .send({ realizedPnlAtomic: "-100000", finalized: true })
          .expect(200);
        assert.equal(closedLoss.body.alphaFeeAccrual, undefined);
        const unrealized = await request(finalRestart.app)
          .post("/v1/copy/decide")
          .send({ copySettingsId, sourceAction: sourceAction(`source-unrealized-${suffix}`), createLot: true })
          .expect(200);
        await request(finalRestart.app)
          .post(`/v1/copy/lots/${unrealized.body.copiedLot.copiedLotId}/finalize`)
          .send({ realizedPnlAtomic: "100000", finalized: false })
          .expect(422);
      } finally {
        stopApp(finalRestart);
      }
    }));
  }

  results.push(await expectSafe("webhook test receiver is unavailable without sandbox gate", async () => {
    const app = makeApp({ webhookSigningSecret: "mayhem-webhook-secret" });
    try {
      const envelope = webhookEnvelope("mayhem-webhook-secret", {
        idempotencyKey: "wh-disabled",
        event: "quote.created",
      });
      await request(app.app).post("/v1/webhooks/receiver-test").send(envelope).expect(404);
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("webhook HTTP receiver accepts valid delivery once and rejects replay", async () => {
    const secret = "mayhem-webhook-secret";
    const app = makeApp({
      nodeEnv: "test",
      webhookSigningSecret: secret,
      runtimeGates: webhookReceiverGates(),
    });
    try {
      const envelope = webhookEnvelope(secret, {
        idempotencyKey: "wh-valid-once",
        event: "quote.created",
      });
      await request(app.app).post("/v1/webhooks/receiver-test").send(envelope).expect(202);
      await request(app.app).post("/v1/webhooks/receiver-test").send(envelope).expect(409);
      assert(app.context.auditLog.query({ kind: "WEBHOOK_RECEIVED", limit: 20 }).some((entry) => entry.meta?.idempotencyKey === "wh-valid-once"));
      assert(app.context.auditLog.query({ kind: "WEBHOOK_REPLAY_REJECTED", limit: 20 }).some((entry) => entry.meta?.idempotencyKey === "wh-valid-once"));
      const metrics = await request(app.app).get("/metrics").expect(200);
      assert.match(metrics.text, /x402_webhook_replays_rejected_total 1/);
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("webhook HTTP receiver rejects bad signature and old timestamp", async () => {
    const secret = "mayhem-webhook-secret";
    const app = makeApp({
      nodeEnv: "test",
      webhookSigningSecret: secret,
      runtimeGates: webhookReceiverGates(),
    });
    try {
      const badSignature = {
        ...webhookEnvelope(secret, { idempotencyKey: "wh-bad-signature", event: "quote.created" }),
        signature: "00".repeat(32),
      };
      await request(app.app).post("/v1/webhooks/receiver-test").send(badSignature).expect(401);

      const oldTimestamp = webhookEnvelope(secret, {
        idempotencyKey: "wh-old-timestamp",
        event: "quote.created",
        timestamp: new Date(Date.now() - 600_000).toISOString(),
      });
      await request(app.app).post("/v1/webhooks/receiver-test").send(oldTimestamp).expect(400);
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("webhook HTTP receiver blocks PII before immutable delivery log", async () => {
    const secret = "mayhem-webhook-secret";
    const app = makeApp({
      nodeEnv: "test",
      webhookSigningSecret: secret,
      runtimeGates: webhookReceiverGates(),
    });
    try {
      const piiEnvelope = rawSignedWebhookEnvelope(secret, {
        idempotencyKey: "wh-pii",
        event: "fulfillment.completed",
        payload: { customerEmail: "buyer@example.com" },
      });
      await request(app.app).post("/v1/webhooks/receiver-test").send(piiEnvelope).expect(400);
      assert(!app.context.auditLog.query({ kind: "WEBHOOK_RECEIVED", limit: 20 }).some((entry) => entry.meta?.idempotencyKey === "wh-pii"));
      const metrics = await request(app.app).get("/metrics").expect(200);
      assert.match(metrics.text, /x402_pii_blocks_total 1/);
    } finally {
      stopApp(app);
    }
  }));

  if ((process.env.X402_REPOSITORY_MODE ?? "").toLowerCase() === "postgres" && process.env.X402_DATABASE_URL) {
    results.push(await expectSafe("Postgres-backed webhook replay rejected after app restart", async () => {
      const secret = "mayhem-postgres-webhook-secret";
      const idempotencyKey = `wh-postgres-restart-${crypto.randomUUID()}`;
      const envelope = webhookEnvelope(secret, {
        idempotencyKey,
        event: "quote.created",
        payload: { ok: true, persistence: "postgres" },
      });
      const config: Partial<X402Config> = {
        nodeEnv: "test",
        webhookSigningSecret: secret,
        databaseUrl: process.env.X402_DATABASE_URL,
        repositoryMode: "postgres",
        runtimeGates: webhookReceiverGates(),
      };

      const first = makeApp(config);
      try {
        await request(first.app).post("/v1/webhooks/receiver-test").send(envelope).expect(202);
      } finally {
        stopApp(first);
      }

      const restarted = makeApp(config);
      try {
        const replay = await request(restarted.app).post("/v1/webhooks/receiver-test").send(envelope).expect(409);
        assert.equal(replay.body.error, "duplicate_webhook_rejected");
        assert(
          restarted.context.auditLog.query({ kind: "WEBHOOK_REPLAY_REJECTED", limit: 20 })
            .some((entry) => entry.meta?.idempotencyKey === idempotencyKey),
        );
      } finally {
        stopApp(restarted);
      }
    }));
  }

  results.push(await expectSafe("agent builder prompt abuse fails safely", async () => {
    const app = makeApp();
    try {
      const cases = [
        ["Create an agent that stores my private key on the server.", "AGENT_BUILDER_PRIVATE_KEY_FORBIDDEN"],
        ["Create a bot where the backend signs trades.", "AGENT_BUILDER_BACKEND_SIGNING_FORBIDDEN"],
        ["Create a hidden 5% fee.", "AGENT_BUILDER_HIDDEN_FEE_FORBIDDEN"],
        ["Create an unlimited auto-trading bot with no stop loss.", "AGENT_BUILDER_UNATTENDED_LIVE_OUT_OF_SCOPE"],
        ["Create a copy bot that charges alpha fee on losses.", "AGENT_BUILDER_INVALID_ALPHA_FEE"],
        ["Create an agent that bypasses the DNA fee.", "AGENT_BUILDER_HIDDEN_FEE_FORBIDDEN"],
        ["Create an agent that disables emergency pause.", "AGENT_BUILDER_UNATTENDED_LIVE_OUT_OF_SCOPE"],
        ["Create a physical goods high-risk category agent.", "AGENT_BUILDER_HIGH_RISK_CATEGORY_OUT_OF_SCOPE"],
      ] as const;
      for (const [prompt, code] of cases) {
        const response = await request(app.app)
          .post("/v1/agent-builder/draft")
          .send({ inputMode: "PROMPT", prompt, ownerWallet: "mayhem-owner" })
          .expect(422);
        assert.equal(response.body.status, "REJECTED");
        assert(response.body.reasonCodes.includes(code));
      }
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("agent builder safe draft requires explicit risk acknowledgement before confirmation", async () => {
    const app = makeApp();
    try {
      const draft = await request(app.app)
        .post("/v1/agent-builder/draft")
        .send({
          inputMode: "PROMPT",
          ownerWallet: "mayhem-owner",
          prompt: "Create a Polymarket copy agent that follows BTC 5m markets, only copies entries between 40c and 60c, max $5 per bet, stops after $25 daily loss, max open exposure $100, copies buys only, and charges followers 2% of profit.",
        })
        .expect(201);
      await request(app.app)
        .post(`/v1/agent-builder/drafts/${draft.body.draftId}/confirm`)
        .send({ ownerWallet: "mayhem-owner", acceptedRiskSummary: false, confirmations: draft.body.riskSummary.requiredConfirmations })
        .expect(400);
      const confirmed = await request(app.app)
        .post(`/v1/agent-builder/drafts/${draft.body.draftId}/confirm`)
        .send({ ownerWallet: "mayhem-owner", acceptedRiskSummary: true, confirmations: draft.body.riskSummary.requiredConfirmations })
        .expect(200);
      assert.equal(confirmed.body.agentConfig.backendCustody, false);
      assert.equal(confirmed.body.agentConfig.backendSigning, false);
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("public raw graph query rejected", async () => {
    const app = makeApp();
    try {
      await request(app.app).get("/market/events").expect(404);
      await request(app.app).post("/market/dev/events").send({ events: [{ type: "PAYMENT_VERIFIED" }] }).expect(404);
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("competitor seller graph query rejected and admin raw access audited", async () => {
    const app = makeApp();
    try {
      await request(app.app).post("/market/shops").send(signedShop({ shopId: "seller-private" })).expect(201);
      await request(app.app)
        .get("/market/seller-dashboard")
        .query({ shopId: "seller-private" })
        .set("x-dna-seller-owner", bs58.encode(nacl.sign.keyPair().publicKey))
        .expect(403);
      await request(app.app)
        .get("/admin/market/events/raw")
        .set("x-admin-token", "mayhem-admin-secret")
        .set("x-admin-actor", "operator-1")
        .expect(200);
      assert(app.context.auditLog.query({ kind: "ADMIN_ACTION", limit: 100 }).some((entry) => entry.meta?.action === "market.events.raw.read"));
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("public aggregate below threshold hidden", async () => {
    const privacy = new MarketEventPrivacyService([]);
    const result = privacy.publicAggregate([{ id: "one" }], 5);
    assert.equal(result.visible, false);
    assert.equal(result.rows.length, 0);
  }));

  results.push(await expectSafe("PII in receipt blocked before write", async () => {
    const app = makeApp();
    try {
      const { commitId } = await quoteAndCommit(app);
      const res = await request(app.app)
        .post("/finalize")
        .send({ commitId, paymentProof: { settlement: "transfer", txSignature: "tx-ok-email@example.com-123456789012345678901234" } })
        .expect(400);
      assert.equal(res.body.error, "immutable_record_blocked");
      assert.notEqual(res.status, 200);
      assert.equal(app.context.receipts.size, 0);
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("PII in governance audit blocked before write", async () => {
    const app = makeApp();
    try {
      const res = await request(app.app)
        .post("/admin/x402/denylist")
        .set("x-admin-token", "mayhem-admin-secret")
        .send({
          subjectType: "LISTING",
          subjectValue: "bad-listing",
          reasonCode: "evidence",
          evidenceRefs: ["ticket-1"],
          severity: "HIGH",
          createdBy: "operator@example.com",
        })
        .expect(400);
      assert.match(String(res.body.error), /PII_FORBIDDEN/);
      assert.equal(app.context.governance.listDenylistEntries().length, 0);
    } finally {
      stopApp(app);
    }
  }));

  results.push(await expectSafe("sealed bid mismatch and late reveal fail safely", async () => {
    const commit = {
      bidderId: "bidder-1",
      commitmentHash: sealedBidHash({ bidderId: "bidder-1", amountAtomic: "1000", salt: "salt-a" }),
    };
    assert.throws(() => verifySealedBidReveal(commit, { bidderId: "bidder-1", amountAtomic: "2000", salt: "salt-a" }), /does not match/);
    const revealDeadline = Date.parse("2026-05-15T01:00:00.000Z");
    const lateReveal = Date.parse("2026-05-15T01:00:01.000Z");
    assert(lateReveal > revealDeadline);
  }));

  results.push(await expectSafe("bundle max depth and circular dependencies fail safely", async () => {
    assert.throws(() => assertNoBundleCycle([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" },
    ], 4), /circular/);
    assert.throws(() => assertNoBundleCycle([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
    ], 2), /max depth/);
  }));

  results.push(await expectSafe("wash and self volume do not become trusted volume", async () => {
    const self = trustedExternalVolume([
      { buyerWallet: "wallet-a", sellerWallet: "wallet-a", amountAtomic: "1000" },
      { buyerWallet: "wallet-b", sellerWallet: "wallet-c", amountAtomic: "2000", fundingClusterId: "not-related" },
    ]);
    assert.equal(self, "2000");
  }));

  results.push(await expectSafe("bundle circular dependency rejected", async () => {
    const bundles = new BundleRegistry();
    const app = makeApp({}, { bundles });
    try {
      const cycle = {
        manifest: {
          bundleVersion: "bundle-v1",
          bundleId: "cycle",
          ownerPubkey: bs58.encode(nacl.sign.keyPair().publicKey),
          steps: [
            { stepId: "a", shopId: "a", endpointId: "ea", dependsOn: ["c"] },
            { stepId: "b", shopId: "b", endpointId: "eb", dependsOn: ["a"] },
            { stepId: "c", shopId: "c", endpointId: "ec", dependsOn: ["b"] },
          ],
          maxDepth: 4,
        },
        manifestHash: "0".repeat(64),
        signature: "1".repeat(32),
        publishedAt: new Date().toISOString(),
      };
      await request(app.app).post("/market/bundles").send(cycle).expect(400);
    } finally {
      stopApp(app);
    }
  }));

  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await runServerMayhem();
  const failed = results.filter((result) => !result.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, mode: "server", results }, null, 2));
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}
