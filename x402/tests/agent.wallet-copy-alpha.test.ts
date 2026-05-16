import request from "supertest";
import { describe, expect, it } from "vitest";
import { X402Config } from "../src/config.js";
import { PaymentVerifier } from "../src/paymentVerifier.js";
import { ReceiptSigner } from "../src/receipts.js";
import { createX402App } from "../src/server.js";

const baseConfig: X402Config = {
  port: 8080,
  appVersion: "agent-wallet-copy-alpha-test",
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
  adminSecret: "agent-copy-alpha-test-admin-secret",
  publicBeta: {
    enabled: true,
    gateRef: "PUBLIC_BETA_AGENT_PILOT_TEST",
    agentCreation: true,
    paperAgents: true,
    publicAgentProfiles: true,
    copySettings: true,
    alphaMonetization: true,
    liveLowRisk: false,
    requireClientSignature: true,
    backendSigning: false,
    backendCustody: false,
    maxTxUsd: 25,
    maxDailySpendUsd: 250,
    maxDailyLossUsd: 50,
    maxOpenExposureUsd: 100,
  },
};

function makeApp() {
  return createX402App(baseConfig, {
    receiptSigner: ReceiptSigner.generate(),
  });
}

function sourceBuy(input: Partial<Record<string, unknown>> = {}) {
  return {
    sourceActionId: `source-action-${Math.random().toString(36).slice(2)}`,
    sourceAgentId: "alpha-agent",
    actionType: "BUY",
    marketId: "market-40-60",
    category: "prediction_research",
    side: "YES",
    entryPriceBps: 5000,
    sizeAtomic: "100000",
    ...input,
  };
}

async function createCopySettings(app: ReturnType<typeof makeApp>["app"], patch: Record<string, unknown> = {}) {
  const result = await request(app)
    .post("/v1/copy/settings")
    .send({
      followerAgentId: "follower-agent",
      sourceAgentId: "alpha-agent",
      enabled: true,
      mode: "PAPER_COPY",
      copyBuys: true,
      copySells: false,
      copyExits: false,
      minEntryPriceBps: 4000,
      maxEntryPriceBps: 6000,
      maxBetSizeAtomic: "250000",
      maxDailySpendAtomic: "1000000",
      maxDailyLossAtomic: "125000",
      maxOpenExposureAtomic: "500000",
      useSourceExitRules: false,
      customTakeProfitBps: 2000,
      customStopLossBps: 1000,
      requireApprovalAlways: false,
      ...patch,
    })
    .expect(201);
  return result.body.settings as { copySettingsId: string };
}

describe("agent wallets, copy controls, and alpha monetization", () => {
  it("requires explicit Public Beta feature gates for agent endpoints", async () => {
    const { app } = createX402App({ ...baseConfig, publicBeta: undefined }, {
      receiptSigner: ReceiptSigner.generate(),
    });

    const unavailable = await request(app)
      .post("/v1/agents/agent-wallet-1/wallets/register")
      .send({
        ownerWallet: "mother-wallet-public-key",
        publicKey: "agent-wallet-public-key",
        chain: "SOLANA",
      })
      .expect(404);
    expect(unavailable.body.error).toBe("PUBLIC_BETA_FEATURE_UNAVAILABLE");
    expect(unavailable.body.message).toContain("not in beta scope");
  });

  it("enforces Public Beta low-risk live payment caps", async () => {
    const paymentVerifier: PaymentVerifier = {
      async verify(_quote, proof) {
        return { ok: true, settledOnchain: true, txSignature: proof.txSignature ?? "tx-ok-public-beta" };
      },
    };
    const publicBetaConfig: X402Config = {
      ...baseConfig,
      publicBeta: {
        ...baseConfig.publicBeta!,
        liveLowRisk: true,
        maxTxUsd: 0.000001,
        maxDailySpendUsd: 1,
      },
      telegramAlerts: {
        enabled: true,
        botToken: "telegram-bot-token-redacted",
        chatId: "-100123456789",
        parseMode: "HTML",
        relaySecret: "0123456789abcdef01234567",
        commandsEnabled: false,
        allowedUserIds: [],
        allowedAdminIds: [],
        allowedChatIds: [],
        statusMetricsUrl: "http://127.0.0.1:8080/metrics",
      },
    };
    const { app } = createX402App(publicBetaConfig, {
      receiptSigner: ReceiptSigner.generate(),
      paymentVerifier,
    });

    await request(app)
      .get("/quote")
      .query({ resource: "/resource", amountAtomic: "2" })
      .expect(403)
      .expect((res) => {
        expect(res.body.error).toBe("public_beta_cap_exceeded");
      });

    const cappedDailyConfig: X402Config = {
      ...publicBetaConfig,
      publicBeta: {
        ...publicBetaConfig.publicBeta!,
        maxTxUsd: 1,
        maxDailySpendUsd: 1,
      },
    };
    const cappedDaily = createX402App(cappedDailyConfig, {
      receiptSigner: ReceiptSigner.generate(),
      paymentVerifier,
    });
    for (const suffix of ["a", "b"]) {
      const quote = await request(cappedDaily.app)
        .get("/quote")
        .query({ resource: "/resource", amountAtomic: "600000" })
        .expect(200);
      const commit = await request(cappedDaily.app)
        .post("/commit")
        .send({ quoteId: quote.body.quoteId, payerCommitment32B: `0x${suffix.repeat(64)}` })
        .expect(201);
      const expectedStatus = suffix === "a" ? 200 : 403;
      await request(cappedDaily.app)
        .post("/finalize")
        .send({ commitId: commit.body.commitId, paymentProof: { settlement: "transfer", txSignature: `tx-ok-beta-${suffix}-123456789012345678901234` } })
        .expect(expectedStatus);
    }
  });

  it("registers public agent wallets only and rejects backend private-key material", async () => {
    const { app } = makeApp();

    const accepted = await request(app)
      .post("/v1/agents/agent-wallet-1/wallets/register")
      .send({
        ownerWallet: "mother-wallet-public-key",
        publicKey: "agent-wallet-public-key",
        chain: "SOLANA",
        keyStorage: "LOCAL_ENCRYPTED",
      })
      .expect(201);

    expect(accepted.body.wallet.backendHasPrivateKey).toBe(false);
    expect(accepted.body.wallet.custodyModel).toBe("CLIENT_SIDE_USER_OWNED");

    const listed = await request(app).get("/v1/agents/agent-wallet-1/wallets").expect(200);
    expect(listed.body.wallets).toHaveLength(1);
    expect(listed.body.wallets[0].publicKey).toBe("agent-wallet-public-key");

    await request(app)
      .post("/v1/agents/agent-wallet-1/wallets/register")
      .send({
        ownerWallet: "mother-wallet-public-key",
        publicKey: "agent-wallet-public-key-2",
        chain: "SOLANA",
        metadata: { nested: { privateKey: "must-never-touch-backend" } },
      })
      .expect(400)
      .expect((res) => {
        expect(res.body.error).toBe("PRIVATE_KEY_FORBIDDEN");
      });

    await request(app).post("/v1/agents/agent-wallet-1/wallets/sign").send({}).expect(404);
  });

  it("creates paper agents with 10,000 paper USDC and never creates real settlement", async () => {
    const { app } = makeApp();

    const created = await request(app).post("/v1/agents/paper-agent/paper-account").send({}).expect(201);
    expect(created.body.account.startingBalanceAtomic).toBe("10000000000");
    expect(created.body.badge).toBe("PAPER");

    const trade = await request(app)
      .post("/v1/agents/paper-agent/paper-trades")
      .send({
        marketId: "paper-market",
        side: "YES",
        amountAtomic: "5000000",
        priceBps: 5000,
        realizedPnlAtomic: "125000",
      })
      .expect(201);

    expect(trade.body.realSettlement).toBe(false);
    expect(trade.body.token).toBe("PAPER_USDC");
    expect(trade.body.account.realizedPnlAtomic).toBe("125000");

    const profile = await request(app).get("/v1/agents/paper-agent/profile").expect(200);
    expect(profile.body.profile.modeBadge).toBe("PAPER");
    expect(profile.body.profile.badges).toContain("PAPER_ONLY");
  });

  it("supports public/private profiles with avg-entry and sample-size badges", async () => {
    const { app } = makeApp();

    const updated = await request(app)
      .patch("/v1/agents/profile-agent/profile")
      .send({
        visibility: "PUBLIC",
        modeBadge: "LIVE_VERIFIED",
        winRateBps: 9500,
        averageEntryPriceBps: 9600,
        medianEntryPriceBps: 9500,
        tradeCount: 8,
        resolvedTradeCount: 8,
        totalVolumeAtomic: "8000000",
      })
      .expect(200);

    expect(updated.body.profile.visibility).toBe("PUBLIC");
    expect(updated.body.profile.averageEntryPriceBps).toBe(9600);
    expect(updated.body.profile.badges).toContain("HIGH_AVG_ENTRY");
    expect(updated.body.profile.badges).toContain("LOW_SAMPLE_SIZE");

    const leaderboard = await request(app).get("/v1/leaderboard").expect(200);
    expect(leaderboard.body.agents.map((agent: { agentId: string }) => agent.agentId)).toContain("profile-agent");
  });

  it("locks alpha fee bps at copied-lot entry and charges only positive finalized copied-lot PnL", async () => {
    const { app } = makeApp();

    await request(app)
      .post("/v1/agents/alpha-agent/monetization")
      .send({ enabled: true, successFeeBps: 100, mode: "ACCRUAL" })
      .expect(200);

    await request(app)
      .post("/v1/agents/alpha-agent/monetization")
      .send({ enabled: true, successFeeBps: 400, mode: "ACCRUAL" })
      .expect(400);

    await request(app)
      .post("/v1/agents/alpha-agent/monetization")
      .send({ enabled: true, successFeeBps: 100, mode: "DIRECT_SPLIT_GATED" })
      .expect(403);

    const settings = await createCopySettings(app);
    const decision = await request(app)
      .post("/v1/copy/decide")
      .send({
        copySettingsId: settings.copySettingsId,
        sourceAction: sourceBuy(),
        createLot: true,
      })
      .expect(200);

    expect(decision.body.decision.decision).toBe("COPY");
    expect(decision.body.copiedLot.alphaFeeBpsAtEntry).toBe(100);
    expect(decision.body.copiedLot.followerTakeProfitBps).toBe(2000);
    expect(decision.body.copiedLot.followerStopLossBps).toBe(1000);

    await request(app)
      .post("/v1/agents/alpha-agent/monetization")
      .send({ enabled: true, successFeeBps: 300, mode: "ACCRUAL" })
      .expect(200);

    const finalized = await request(app)
      .post(`/v1/copy/lots/${decision.body.copiedLot.copiedLotId}/finalize`)
      .send({ realizedPnlAtomic: "100000", finalized: true })
      .expect(200);

    expect(finalized.body.lot.status).toBe("CLOSED_WIN");
    expect(finalized.body.alphaFeeAccrual.feeBps).toBe(100);
    expect(finalized.body.alphaFeeAccrual.feeAmountAtomic).toBe("1000");

    await request(app)
      .post(`/v1/copy/lots/${decision.body.copiedLot.copiedLotId}/finalize`)
      .send({ realizedPnlAtomic: "100000", finalized: true })
      .expect(409);

    const lossDecision = await request(app)
      .post("/v1/copy/decide")
      .send({
        copySettingsId: settings.copySettingsId,
        sourceAction: sourceBuy({ sourceActionId: "loss-source-action" }),
        createLot: true,
      })
      .expect(200);

    const loss = await request(app)
      .post(`/v1/copy/lots/${lossDecision.body.copiedLot.copiedLotId}/finalize`)
      .send({ realizedPnlAtomic: "-100000", finalized: true })
      .expect(200);
    expect(loss.body.lot.status).toBe("CLOSED_LOSS");
    expect(loss.body.alphaFeeAccrual).toBeUndefined();

    const unrealizedDecision = await request(app)
      .post("/v1/copy/decide")
      .send({
        copySettingsId: settings.copySettingsId,
        sourceAction: sourceBuy({ sourceActionId: "unrealized-source-action" }),
        createLot: true,
      })
      .expect(200);

    await request(app)
      .post(`/v1/copy/lots/${unrealizedDecision.body.copiedLot.copiedLotId}/finalize`)
      .send({ realizedPnlAtomic: "100000", finalized: false })
      .expect(422);
  });

  it("enforces follower copy filters, risk caps, approval thresholds, and emergency pause", async () => {
    const { app } = makeApp();
    const settings = await createCopySettings(app);

    const copied = await request(app)
      .post("/v1/copy/decide")
      .send({ copySettingsId: settings.copySettingsId, sourceAction: sourceBuy() })
      .expect(200);
    expect(copied.body.decision.decision).toBe("COPY");

    const highEntry = await request(app)
      .post("/v1/copy/decide")
      .send({ copySettingsId: settings.copySettingsId, sourceAction: sourceBuy({ entryPriceBps: 8000 }) })
      .expect(200);
    expect(highEntry.body.decision.decision).toBe("SKIP");
    expect(highEntry.body.decision.reasonCodes).toContain("ENTRY_PRICE_ABOVE_MAX");

    const sell = await request(app)
      .post("/v1/copy/decide")
      .send({ copySettingsId: settings.copySettingsId, sourceAction: sourceBuy({ actionType: "SELL" }) })
      .expect(200);
    expect(sell.body.decision.reasonCodes).toContain("COPY_SELLS_DISABLED");

    const exit = await request(app)
      .post("/v1/copy/decide")
      .send({ copySettingsId: settings.copySettingsId, sourceAction: sourceBuy({ actionType: "EXIT" }) })
      .expect(200);
    expect(exit.body.decision.reasonCodes).toContain("COPY_EXITS_DISABLED");

    const overBet = await request(app)
      .post("/v1/copy/decide")
      .send({ copySettingsId: settings.copySettingsId, sourceAction: sourceBuy({ sizeAtomic: "300000" }) })
      .expect(200);
    expect(overBet.body.decision.reasonCodes).toContain("MAX_BET_SIZE_EXCEEDED");

    const overDaily = await request(app)
      .post("/v1/copy/decide")
      .send({
        copySettingsId: settings.copySettingsId,
        sourceAction: sourceBuy(),
        currentDailySpendAtomic: "950001",
      })
      .expect(200);
    expect(overDaily.body.decision.reasonCodes).toContain("MAX_DAILY_SPEND_EXCEEDED");

    const overExposure = await request(app)
      .post("/v1/copy/decide")
      .send({
        copySettingsId: settings.copySettingsId,
        sourceAction: sourceBuy(),
        currentOpenExposureAtomic: "450001",
      })
      .expect(200);
    expect(overExposure.body.decision.reasonCodes).toContain("MAX_OPEN_EXPOSURE_EXCEEDED");

    const overDailyLoss = await request(app)
      .post("/v1/copy/decide")
      .send({
        copySettingsId: settings.copySettingsId,
        sourceAction: sourceBuy(),
        currentDailyLossAtomic: "125000",
      })
      .expect(200);
    expect(overDailyLoss.body.decision.reasonCodes).toContain("MAX_DAILY_LOSS_EXCEEDED");

    const blockedSettings = await createCopySettings(app, {
      copySettingsId: "blocked-market-settings",
      blockedMarketIds: ["blocked-market"],
    });
    const blockedMarket = await request(app)
      .post("/v1/copy/decide")
      .send({
        copySettingsId: blockedSettings.copySettingsId,
        sourceAction: sourceBuy({ marketId: "blocked-market" }),
      })
      .expect(200);
    expect(blockedMarket.body.decision.decision).toBe("SKIP");
    expect(blockedMarket.body.decision.reasonCodes).toContain("MARKET_BLOCKED");

    const approvalSettings = await createCopySettings(app, {
      copySettingsId: "approval-settings",
      requireApprovalAboveAtomic: "50000",
    });
    const approval = await request(app)
      .post("/v1/copy/decide")
      .send({ copySettingsId: approvalSettings.copySettingsId, sourceAction: sourceBuy() })
      .expect(200);
    expect(approval.body.decision.decision).toBe("REVIEW_REQUIRED");
    expect(approval.body.decision.reasonCodes).toContain("APPROVAL_REQUIRED");

    const paused = await request(app)
      .post("/v1/copy/decide")
      .send({ copySettingsId: settings.copySettingsId, sourceAction: sourceBuy(), emergencyPaused: true })
      .expect(200);
    expect(paused.body.decision.decision).toBe("SKIP");
    expect(paused.body.decision.reasonCodes).toContain("EMERGENCY_PAUSED");

    const liveGatedSettings = await createCopySettings(app, {
      copySettingsId: "live-gated-settings",
      mode: "AUTO_COPY_PUBLIC_BETA",
      requireApprovalAlways: false,
    });
    const liveGated = await request(app)
      .post("/v1/copy/decide")
      .send({ copySettingsId: liveGatedSettings.copySettingsId, sourceAction: sourceBuy() })
      .expect(200);
    expect(liveGated.body.decision.reasonCodes).toContain("LIVE_COPY_GATED");
  });
});
