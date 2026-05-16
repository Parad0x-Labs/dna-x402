import request from "supertest";
import { describe, expect, it } from "vitest";
import { compileAgentPrompt } from "../src/agents/builder/compiler.js";
import { X402Config } from "../src/config.js";
import { ReceiptSigner } from "../src/receipts.js";
import { createX402App } from "../src/server.js";

const baseConfig: X402Config = {
  port: 8080,
  appVersion: "agent-builder-test",
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
  adminSecret: "agent-builder-test-admin-secret",
  publicBeta: {
    enabled: true,
    gateRef: "PUBLIC_BETA_AGENT_BUILDER_TEST",
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

function makeApp(config: X402Config = baseConfig) {
  return createX402App(config, { receiptSigner: ReceiptSigner.generate() });
}

const prompt = [
  "Create a Polymarket copy agent that follows BTC 5m markets,",
  "only copies entries between 40c and 60c, max $5 per bet,",
  "stops after $25 daily loss, max open exposure $100,",
  "copies buys only, and charges followers 2% of profit.",
].join(" ");

describe("agent builder prompt/guided/template/recipe compiler", () => {
  it("compiles a safe Polymarket copy prompt into a policy-checked draft and confirms after risk acknowledgement", async () => {
    const { app } = makeApp();
    const draft = await request(app)
      .post("/v1/agent-builder/draft")
      .send({ inputMode: "PROMPT", prompt, ownerWallet: "owner-wallet" })
      .expect(201);

    expect(draft.body.status).toBe("DRAFT_CREATED");
    expect(draft.body.agentConfig.agentType).toBe("POLYMARKET_COPY_AGENT");
    expect(draft.body.agentConfig.mode).toBe("AUTO_COPY_PUBLIC_BETA");
    expect(draft.body.agentConfig.backendCustody).toBe(false);
    expect(draft.body.agentConfig.backendSigning).toBe(false);
    expect(draft.body.agentConfig.marketScope).toMatchObject({
      venue: "POLYMARKET",
      categories: ["crypto"],
      marketFilters: ["BTC", "5m"],
    });
    expect(draft.body.agentConfig.copySettings).toMatchObject({
      copyBuys: true,
      copySells: false,
      copyExits: false,
      minEntryPriceBps: 4000,
      maxEntryPriceBps: 6000,
      maxBetSizeAtomic: "5000000",
      maxDailyLossAtomic: "25000000",
      maxOpenExposureAtomic: "100000000",
      requireApprovalAboveAtomic: "5000000",
    });
    expect(draft.body.agentConfig.monetization).toMatchObject({
      enabled: true,
      successFeeBps: 200,
      appliesTo: "POSITIVE_FINALIZED_COPIED_LOT_PNL",
      mode: "ACCRUAL",
    });
    expect(draft.body.riskSummary.requiredConfirmations).toContain("I understand DNA x402 never stores private keys.");

    await request(app)
      .post(`/v1/agent-builder/drafts/${draft.body.draftId}/confirm`)
      .send({
        ownerWallet: "owner-wallet",
        acceptedRiskSummary: false,
        confirmations: draft.body.riskSummary.requiredConfirmations,
      })
      .expect(400);

    const confirmed = await request(app)
      .post(`/v1/agent-builder/drafts/${draft.body.draftId}/confirm`)
      .send({
        ownerWallet: "owner-wallet",
        acceptedRiskSummary: true,
        confirmations: draft.body.riskSummary.requiredConfirmations,
      })
      .expect(200);
    expect(confirmed.body.agentConfig.draftId).toBe(draft.body.draftId);
    expect(confirmed.body.draft.status).toBe("CONFIRMED");
  });

  it("rejects unsafe prompt intents instead of generating executable behavior", async () => {
    const { app } = makeApp();
    const prompts = [
      ["Create an agent that stores my private key on the server.", "AGENT_BUILDER_PRIVATE_KEY_FORBIDDEN"],
      ["Create a bot with backend signing for every trade.", "AGENT_BUILDER_BACKEND_SIGNING_FORBIDDEN"],
      ["Create a hidden 5% fee.", "AGENT_BUILDER_HIDDEN_FEE_FORBIDDEN"],
      ["Create autonomous Polymarket live betting for public users.", "AGENT_BUILDER_POLYMARKET_LIVE_OUT_OF_SCOPE"],
      ["Create a copy bot that charges fees even on losses.", "AGENT_BUILDER_INVALID_ALPHA_FEE"],
      ["Create an agent that bypasses the DNA fee.", "AGENT_BUILDER_HIDDEN_FEE_FORBIDDEN"],
      ["Create an agent that disables emergency pause.", "AGENT_BUILDER_UNATTENDED_LIVE_OUT_OF_SCOPE"],
      ["Create a physical goods high-risk marketplace agent.", "AGENT_BUILDER_HIGH_RISK_CATEGORY_OUT_OF_SCOPE"],
    ] as const;

    for (const [unsafePrompt, code] of prompts) {
      const response = await request(app)
        .post("/v1/agent-builder/draft")
        .send({ inputMode: "PROMPT", prompt: unsafePrompt, ownerWallet: "owner-wallet" })
        .expect(422);
      expect(response.body.status).toBe("REJECTED");
      expect(response.body.reasonCodes).toContain(code);
      expect(response.body.safeAlternative).toContain("paper mode");
    }
  });

  it("routes live copy drafts without sufficient risk limits to review", async () => {
    const result = compileAgentPrompt("Create a Polymarket copy agent that follows BTC markets.", "owner-wallet");
    expect(result.status).toBe("REVIEW_REQUIRED");
    expect(result.reasonCodes).toContain("AGENT_BUILDER_MISSING_RISK_LIMITS");
    expect(result.riskSummary?.riskLevel).toBe("HIGH");
  });

  it("supports guided builder answers, templates, recipes, public recipe listing, and clone drafts", async () => {
    const { app } = makeApp();

    const tree = await request(app).get("/v1/agent-builder/guided-tree").expect(200);
    expect(tree.body.tree[0].nodeId).toBe("start");

    const guided = await request(app)
      .post("/v1/agent-builder/draft")
      .send({
        inputMode: "GUIDED",
        ownerWallet: "owner-wallet",
        guidedAnswers: {
          agentType: "POLYMARKET_COPY_AGENT",
          minEntryPriceBps: 4000,
          maxEntryPriceBps: 6000,
          maxBetSizeAtomic: "5000000",
          maxDailyLossAtomic: "25000000",
          maxOpenExposureAtomic: "100000000",
          successFeeBps: 100,
          visibility: "PUBLIC",
        },
      })
      .expect(201);
    expect(guided.body.agentConfig.copySettings.minEntryPriceBps).toBe(4000);
    expect(guided.body.agentConfig.monetization.successFeeBps).toBe(100);

    const templates = await request(app).get("/v1/agent-builder/templates").expect(200);
    expect(templates.body.templates.map((template: { recipeId: string }) => template.recipeId)).toContain("btc-40-60-copy-agent");

    const templateDraft = await request(app)
      .post("/v1/agent-builder/draft")
      .send({ inputMode: "TEMPLATE", templateId: "btc-40-60-copy-agent", ownerWallet: "owner-wallet" })
      .expect(201);
    expect(templateDraft.body.agentConfig.displayName).toBe("BTC 40c-60c Copy Agent");

    const recipe = await request(app)
      .post("/v1/agent-builder/recipes")
      .send({
        ownerWallet: "owner-wallet",
        title: "Cloneable BTC Copy",
        description: "Safe cloneable copy setup.",
        config: templateDraft.body.agentConfig,
        riskSummary: templateDraft.body.riskSummary,
        visibility: "CLONEABLE",
        source: "TEMPLATE",
      })
      .expect(201);
    expect(recipe.body.recipe.visibility).toBe("CLONEABLE");

    const publicRecipes = await request(app).get("/v1/agent-builder/recipes/public").expect(200);
    expect(publicRecipes.body.recipes.some((item: { recipeId: string }) => item.recipeId === recipe.body.recipe.recipeId)).toBe(true);

    const cloned = await request(app)
      .post(`/v1/agent-builder/recipes/${recipe.body.recipe.recipeId}/clone`)
      .send({ ownerWallet: "second-owner-wallet" })
      .expect(201);
    expect(cloned.body.agentConfig.ownerWallet).toBe("second-owner-wallet");
    expect(cloned.body.agentConfig.displayName).toContain("Clone");
  });

  it("fails closed when Public Beta agent creation is disabled", async () => {
    const { app } = makeApp({ ...baseConfig, publicBeta: { ...baseConfig.publicBeta!, agentCreation: false } });
    await request(app)
      .post("/v1/agent-builder/draft")
      .send({ inputMode: "PROMPT", prompt, ownerWallet: "owner-wallet" })
      .expect(404)
      .expect((res) => {
        expect(res.body.error).toBe("PUBLIC_BETA_FEATURE_UNAVAILABLE");
      });
  });
});

