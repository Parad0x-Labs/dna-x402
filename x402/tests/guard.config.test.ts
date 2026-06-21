import { describe, expect, it } from "vitest";
import {
  assertMainnetReadiness,
  loadConfig,
  runtimeGatesForConfig,
  validateMainnetReadiness,
  validateRuntimeGateConfig,
} from "../src/config.js";

describe("DNA Guard config", () => {
  it("keeps insecure transport disabled unless explicitly enabled", () => {
    expect(loadConfig({}).allowInsecure).toBe(false);
    expect(loadConfig({ ALLOW_INSECURE: "1" }).allowInsecure).toBe(true);
  });

  it("loads guard flags and spend ceilings from env", () => {
    const config = loadConfig({
      CLUSTER: "devnet",
      PORT: "8080",
      APP_VERSION: "test",
      SOLANA_RPC_URL: "https://api.devnet.solana.com",
      USDC_MINT: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      PAYMENT_RECIPIENT: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      DNA_GUARD_ENABLED: "true",
      DNA_GUARD_FAIL_MODE: "fail-closed",
      DNA_GUARD_WINDOW_MS: "60000",
      DNA_GUARD_SNAPSHOT_PATH: "./tmp/guard.json",
      DNA_GUARD_BUYER_CEILING_ATOMIC: "1000",
      DNA_GUARD_WALLET_CEILING_ATOMIC: "2000",
      DNA_GUARD_AGENT_CEILING_ATOMIC: "3000",
      DNA_GUARD_API_KEY_CEILING_ATOMIC: "4000",
    });

    expect(config.dnaGuard).toEqual({
      enabled: true,
      failMode: "fail-closed",
      windowMs: 60_000,
      snapshotPath: "./tmp/guard.json",
      spendCeilings: {
        buyerAtomic: "1000",
        walletAtomic: "2000",
        agentAtomic: "3000",
        apiKeyAtomic: "4000",
      },
    });
  });

  it("rejects unsafe mainnet runtime config", () => {
    const config = loadConfig({
      CLUSTER: "mainnet-beta",
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      USDC_MINT: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      PAYMENT_RECIPIENT: "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2",
      ALLOW_INSECURE: "1",
      UNSAFE_UNVERIFIED_NETTING_ENABLED: "1",
      DNA_GUARD_ENABLED: "1",
      DNA_GUARD_FAIL_MODE: "fail-open",
    });

    expect(validateMainnetReadiness(config)).toEqual(expect.arrayContaining([
      "ALLOW_INSECURE must be disabled on mainnet.",
      "ADMIN_SECRET must be set and at least 24 characters on mainnet.",
      "RECEIPT_SIGNING_SECRET must be set and at least 24 characters on mainnet.",
      "USDC_MINT must be the canonical mainnet USDC mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.",
      "PAYMENT_RECIPIENT still uses the bundled devnet recipient.",
      "UNSAFE_UNVERIFIED_NETTING_ENABLED must be disabled on mainnet.",
      "DNA_GUARD_FAIL_MODE must be fail-closed when DNA Guard is enabled on mainnet.",
      "ANCHORING_ENABLED must be enabled on mainnet.",
    ]));
    expect(() => assertMainnetReadiness(config)).toThrow("Mainnet readiness check failed");
  });

  it("accepts a hardened mainnet runtime config", () => {
    const config = loadConfig({
      CLUSTER: "mainnet-beta",
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      PAYMENT_RECIPIENT: "11111111111111111111111111111112",
      ADMIN_SECRET: "admin-secret-mainnet-123456",
      RECEIPT_SIGNING_SECRET: "receipt-secret-mainnet-123456",
      ANCHORING_ENABLED: "1",
      RECEIPT_ANCHOR_PROGRAM_ID: "6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN",
      ANCHORING_KEYPAIR_PATH: "./test-mainnet/keys/mainnet/anchoring.json",
      DNA_GUARD_ENABLED: "1",
      DNA_GUARD_FAIL_MODE: "fail-closed",
      SETTLEMENT_COMMITMENT: "finalized",
    });

    expect(validateMainnetReadiness(config)).toEqual([]);
    expect(() => assertMainnetReadiness(config)).not.toThrow();
  });

  it("keeps public production gates disabled by default and rejects explicit live movement flags", () => {
    const defaults = loadConfig({});
    expect(defaults.liveMoneyMovementEnabled).toBe(false);
    expect(defaults.polymarketLiveMovementEnabled).toBe(false);
    expect(defaults.publicNettingEnabled).toBe(false);
    expect(defaults.publicPhysicalGoodsEnabled).toBe(false);
    expect(defaults.publicHighRiskCategoriesEnabled).toBe(false);
    expect(runtimeGatesForConfig(defaults)).toMatchObject({
      prodMoney: false,
      polymarketLive: false,
      publicNetting: false,
      physicalGoods: false,
      highRiskCategories: false,
      multiChainSettlement: false,
      unattendedSigning: false,
      backendKeyCustody: false,
      publicMarketplace: false,
      webhookDelivery: false,
      finalize: true,
      quotes: true,
      webhookReceiverTest: false,
    });

    const config = loadConfig({
      CLUSTER: "mainnet-beta",
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      PAYMENT_RECIPIENT: "11111111111111111111111111111112",
      ADMIN_SECRET: "admin-secret-mainnet-123456",
      RECEIPT_SIGNING_SECRET: "receipt-secret-mainnet-123456",
      ANCHORING_ENABLED: "1",
      RECEIPT_ANCHOR_PROGRAM_ID: "6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN",
      ANCHORING_KEYPAIR_PATH: "./test-mainnet/keys/mainnet/anchoring.json",
      LIVE_MONEY_MOVEMENT_ENABLED: "1",
      POLYMARKET_LIVE_MOVEMENT_ENABLED: "1",
      PUBLIC_NETTING_ENABLED: "1",
      PUBLIC_PHYSICAL_GOODS_ENABLED: "1",
      PUBLIC_HIGH_RISK_CATEGORIES_ENABLED: "1",
    });

    expect(validateMainnetReadiness(config)).toEqual(expect.arrayContaining([
      "LIVE_MONEY_MOVEMENT_ENABLED remains gated and must be disabled.",
      "PUBLIC_NETTING_ENABLED remains gated and must be disabled.",
      "PUBLIC_PHYSICAL_GOODS_ENABLED remains gated and must be disabled.",
      "PUBLIC_HIGH_RISK_CATEGORIES_ENABLED remains gated and must be disabled.",
    ]));
  });

  it("normalizes new X402_ENABLE aliases through centralized runtime gates", () => {
    const config = loadConfig({
      X402_ENABLE_PROD_MONEY: "1",
      X402_ENABLE_POLYMARKET_LIVE: "1",
      X402_ENABLE_PUBLIC_NETTING: "1",
      X402_ENABLE_PHYSICAL_GOODS: "1",
      X402_ENABLE_HIGH_RISK_CATEGORIES: "1",
      X402_ENABLE_MULTI_CHAIN_SETTLEMENT: "1",
      X402_ENABLE_WEBHOOK_DELIVERY: "1",
      X402_ENABLE_FINALIZE: "0",
      X402_ENABLE_QUOTES: "0",
    });

    expect(runtimeGatesForConfig(config)).toMatchObject({
      prodMoney: true,
      polymarketLive: true,
      publicNetting: true,
      physicalGoods: true,
      highRiskCategories: true,
      multiChainSettlement: true,
      webhookDelivery: true,
      finalize: false,
      quotes: false,
    });
    expect(config.liveMoneyMovementEnabled).toBe(true);
    expect(config.polymarketLiveMovementEnabled).toBe(true);
    expect(config.publicNettingEnabled).toBe(true);
  });

  it("requires checklist references for production-like dangerous gate enables", () => {
    const unsafe = loadConfig({
      NODE_ENV: "production",
      X402_ENABLE_PROD_MONEY: "1",
      X402_ENABLE_PUBLIC_MARKETPLACE: "1",
    });

    expect(validateRuntimeGateConfig(unsafe)).toEqual(expect.arrayContaining([
      "X402_PROD_MONEY_CHECKLIST_REF is required before enabling prodMoney in production-like config.",
      "X402_PUBLIC_MARKETPLACE_CHECKLIST_REF is required before enabling publicMarketplace in production-like config.",
    ]));

    const referenced = loadConfig({
      NODE_ENV: "production",
      X402_ENABLE_PROD_MONEY: "1",
      X402_PROD_MONEY_CHECKLIST_REF: "docs/DNA_X402_LIVE_GATE_CHECKLISTS.md#production-money-movement-gate",
    });

    expect(validateRuntimeGateConfig(referenced)).not.toContain(
      "X402_PROD_MONEY_CHECKLIST_REF is required before enabling prodMoney in production-like config.",
    );

    const polymarketMissingRef = loadConfig({
      NODE_ENV: "production",
      X402_ENABLE_POLYMARKET_LIVE: "1",
    });
    expect(validateRuntimeGateConfig(polymarketMissingRef)).toContain(
      "X402_POLYMARKET_LIVE_CHECKLIST_REF is required before enabling polymarketLive in production-like config.",
    );

    const polymarketWithRef = loadConfig({
      NODE_ENV: "production",
      X402_ENABLE_POLYMARKET_LIVE: "1",
      X402_POLYMARKET_LIVE_CHECKLIST_REF: "docs/DNA_X402_POLYMARKET_LIVE_CONSTITUTION.md#live-gate-lock",
    });
    expect(validateRuntimeGateConfig(polymarketWithRef)).not.toContain(
      "X402_POLYMARKET_LIVE_CHECKLIST_REF is required before enabling polymarketLive in production-like config.",
    );
  });

  it("hard-rejects backend custody and unattended signing gates", () => {
    const config = loadConfig({
      X402_ENABLE_BACKEND_KEY_CUSTODY: "1",
      X402_ENABLE_UNATTENDED_SIGNING: "1",
      X402_BACKEND_KEY_CUSTODY_CHECKLIST_REF: "not-enough",
      X402_UNATTENDED_SIGNING_CHECKLIST_REF: "not-enough",
    });

    expect(validateRuntimeGateConfig(config)).toEqual(expect.arrayContaining([
      "X402_ENABLE_BACKEND_KEY_CUSTODY is hard-disabled; backend private key custody is forbidden.",
      "X402_ENABLE_UNATTENDED_SIGNING is hard-disabled; unattended live signing is forbidden in this pass.",
    ]));
  });

  it("keeps the webhook test receiver impossible in production config", () => {
    const productionReceiver = loadConfig({
      NODE_ENV: "production",
      X402_ENABLE_WEBHOOK_RECEIVER_TEST: "1",
    });

    expect(validateRuntimeGateConfig(productionReceiver)).toEqual(expect.arrayContaining([
      "X402_ENABLE_WEBHOOK_RECEIVER_TEST must be disabled in production.",
    ]));

    const receiverWithLiveMoney = loadConfig({
      NODE_ENV: "test",
      X402_ENABLE_WEBHOOK_RECEIVER_TEST: "1",
      X402_ENABLE_PROD_MONEY: "1",
    });

    expect(validateRuntimeGateConfig(receiverWithLiveMoney)).toEqual(expect.arrayContaining([
      "X402_ENABLE_WEBHOOK_RECEIVER_TEST requires live money movement to stay disabled.",
    ]));
  });

  it("keeps real-chain drill private, allowlisted, capped, and non-custodial", () => {
    const unsafe = loadConfig({
      NODE_ENV: "production",
      X402_ENABLE_REAL_CHAIN_DRILL: "1",
      X402_ENABLE_PROD_MONEY: "1",
      X402_ENABLE_PUBLIC_MARKETPLACE: "1",
      X402_REAL_CHAIN_FEE_MODE: "display_only",
      X402_REAL_CHAIN_PLATFORM_FEE_BPS: "25",
    });

    expect(validateRuntimeGateConfig(unsafe)).toEqual(expect.arrayContaining([
      "X402_ENABLE_REAL_CHAIN_DRILL is private-staging only and must be disabled in production.",
      "X402_ENABLE_REAL_CHAIN_DRILL requires X402_ENABLE_PROD_MONEY to remain disabled.",
      "X402_ENABLE_REAL_CHAIN_DRILL requires public marketplace to remain disabled.",
      "X402_REAL_CHAIN_ALLOWED_SIGNERS must include at least one allowlisted signer wallet.",
      "X402_REAL_CHAIN_MAX_TX_ATOMIC must be set for dust-size drill limits.",
      "X402_REAL_CHAIN_DAILY_CAP_ATOMIC must be set for dust-size drill limits.",
      "Real-chain fee drill must use exactly 10 bps when fee display/accrual is enabled.",
      "X402_REAL_CHAIN_PLATFORM_RECIPIENT must be set when fee display/accrual is enabled.",
    ]));

    const safe = loadConfig({
      NODE_ENV: "staging",
      X402_ENABLE_REAL_CHAIN_DRILL: "1",
      X402_REAL_CHAIN_ALLOWED_SIGNERS: "buyer-wallet-1,buyer-wallet-2",
      X402_REAL_CHAIN_MAX_TX_ATOMIC: "100000",
      X402_REAL_CHAIN_DAILY_CAP_ATOMIC: "5000000",
      X402_REAL_CHAIN_FEE_MODE: "display_only",
      X402_REAL_CHAIN_PLATFORM_FEE_BPS: "10",
      X402_REAL_CHAIN_PLATFORM_RECIPIENT: "treasury-wallet",
    });

    expect(validateRuntimeGateConfig(safe)).toEqual([]);
    expect(safe.realChainDrill).toMatchObject({
      enabled: true,
      allowedSigners: ["buyer-wallet-1", "buyer-wallet-2"],
      maxTxAtomic: "100000",
      dailyCapAtomic: "5000000",
      feeMode: "display_only",
      platformFeeBps: 10,
      platformRecipient: "treasury-wallet",
    });
  });

  it("centralizes builder monetization gates and keeps direct split disabled by default", () => {
    const defaults = loadConfig({});
    expect(defaults.builderMonetization).toMatchObject({
      platformFeeBps: 10,
      platformFeeMode: "display_only",
      builderFeesEnabled: true,
      builderFeeDefaultMode: "display_only",
      builderFeeMaxBps: 500,
      affiliateFeesEnabled: false,
      affiliateFeeMaxBps: 200,
      directSplitFeesEnabled: false,
    });
    expect(validateRuntimeGateConfig(defaults)).toEqual([]);

    const unsafe = loadConfig({
      X402_ENABLE_DIRECT_SPLIT_FEES: "1",
      X402_BUILDER_FEE_DEFAULT_MODE: "direct_split",
      X402_PLATFORM_FEE_MODE: "direct_split",
      X402_ENABLE_AUTO_SWEEP: "1",
      X402_AUTO_SWEEP_THRESHOLD_SOL: "0.05",
      X402_BUILDER_FEE_MAX_BPS: "600",
    });

    expect(validateRuntimeGateConfig(unsafe)).toEqual(expect.arrayContaining([
      "Auto-sweep and SOL-equivalent fee thresholds are forbidden; fees must be display/accrual or gated direct split.",
      "X402_PLATFORM_FEE_TREASURY is required when DNA platform fee accrual or direct split is enabled.",
      "X402_DIRECT_SPLIT_GATE_REF is required before enabling direct split fees.",
      "Legacy FEE_BPS/BASE_FEE_ATOMIC/MIN_FEE_ATOMIC must be zero when direct split platform fees are enabled.",
      "X402_BUILDER_FEE_MAX_BPS cannot exceed 500 bps without a new risk review.",
    ]));

    const builderAccrual = loadConfig({
      X402_PLATFORM_FEE_MODE: "seller_accrual",
      X402_PLATFORM_FEE_TREASURY: "dna-treasury",
      X402_BUILDER_FEE_DEFAULT_MODE: "builder_accrual",
      X402_BUILDER_FEE_MAX_BPS: "250",
    });

    expect(validateRuntimeGateConfig(builderAccrual)).toEqual([]);
    expect(builderAccrual.builderMonetization).toMatchObject({
      platformFeeMode: "seller_accrual",
      platformTreasury: "dna-treasury",
      builderFeeDefaultMode: "builder_accrual",
      builderFeeMaxBps: 250,
    });
  });

  it("allows direct split only with an explicit gate and no hidden legacy fee", () => {
    const gated = loadConfig({
      X402_ENABLE_DIRECT_SPLIT_FEES: "1",
      X402_DIRECT_SPLIT_GATE_REF: "public-beta-direct-split-2026-05",
      X402_PLATFORM_FEE_MODE: "direct_split",
      X402_PLATFORM_FEE_BPS: "10",
      X402_PLATFORM_FEE_TREASURY: "dna-treasury",
      FEE_BPS: "0",
      BASE_FEE_ATOMIC: "0",
      MIN_FEE_ATOMIC: "0",
    });
    expect(validateRuntimeGateConfig(gated)).toEqual([]);

    const hiddenLegacyFee = loadConfig({
      X402_ENABLE_DIRECT_SPLIT_FEES: "1",
      X402_DIRECT_SPLIT_GATE_REF: "public-beta-direct-split-2026-05",
      X402_PLATFORM_FEE_MODE: "direct_split",
      X402_PLATFORM_FEE_TREASURY: "dna-treasury",
      FEE_BPS: "30",
    });
    expect(validateRuntimeGateConfig(hiddenLegacyFee)).toEqual(expect.arrayContaining([
      "Legacy FEE_BPS/BASE_FEE_ATOMIC/MIN_FEE_ATOMIC must be zero when direct split platform fees are enabled.",
    ]));

    const productionLike = loadConfig({
      CLUSTER: "mainnet-beta",
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      X402_ENABLE_DIRECT_SPLIT_FEES: "1",
      X402_DIRECT_SPLIT_GATE_REF: "public-beta-direct-split-2026-05",
      X402_PLATFORM_FEE_MODE: "direct_split",
      X402_PLATFORM_FEE_TREASURY: "dna-treasury",
      FEE_BPS: "0",
    });
    expect(validateRuntimeGateConfig(productionLike)).toEqual(expect.arrayContaining([
      "Telegram alerts must be enabled before production-like direct split fee collection.",
      "Helius RPC is required before production-like direct split fee collection.",
      "X402_ENABLE_REAL_CHAIN_DRILL must be enabled for allowlisted Public Beta direct split collection.",
      "X402_REAL_CHAIN_ALLOWED_SIGNERS must be set for Public Beta direct split collection.",
      "X402_REAL_CHAIN_MAX_TX_ATOMIC and X402_REAL_CHAIN_DAILY_CAP_ATOMIC are required for Public Beta direct split collection.",
    ]));

    const publicGateShape = loadConfig({
      NODE_ENV: "production",
      CLUSTER: "mainnet-beta",
      SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=redacted",
      X402_ENABLE_PROD_MONEY: "1",
      X402_PROD_MONEY_CHECKLIST_REF: "docs/DNA_X402_LIVE_GATE_CHECKLISTS.md#low-risk-data-feed-pilot-gate",
      X402_ENABLE_DIRECT_SPLIT_FEES: "1",
      X402_DIRECT_SPLIT_GATE_REF: "docs/DNA_X402_LIVE_GATE_CHECKLISTS.md#direct-split-fee-gate",
      X402_PLATFORM_FEE_MODE: "direct_split",
      X402_PLATFORM_FEE_TREASURY: "dna-treasury",
      FEE_BPS: "0",
      X402_ALERT_TELEGRAM_ENABLED: "1",
      X402_ALERT_TELEGRAM_BOT_TOKEN: "telegram-bot-token-redacted",
      X402_ALERT_TELEGRAM_CHAT_ID: "-100123456789",
      X402_ALERT_TELEGRAM_RELAY_SECRET: "0123456789abcdef01234567",
    });
    expect(validateRuntimeGateConfig(publicGateShape)).not.toEqual(expect.arrayContaining([
      "X402_ENABLE_REAL_CHAIN_DRILL must be enabled for allowlisted Public Beta direct split collection.",
      "X402_REAL_CHAIN_ALLOWED_SIGNERS must be set for Public Beta direct split collection.",
      "X402_REAL_CHAIN_MAX_TX_ATOMIC and X402_REAL_CHAIN_DAILY_CAP_ATOMIC are required for Public Beta direct split collection.",
    ]));
  });

  it("normalizes Public Beta Pilot flags and keeps backend custody/signing impossible", () => {
    const defaults = loadConfig({});
    expect(defaults.publicBeta).toMatchObject({
      enabled: false,
      agentCreation: false,
      paperAgents: false,
      publicAgentProfiles: false,
      copySettings: false,
      alphaMonetization: false,
      liveLowRisk: false,
      backendSigning: false,
      backendCustody: false,
      maxTxUsd: 200,
      maxDailySpendUsd: 1500,
      maxDailyLossUsd: 300,
      maxOpenExposureUsd: 500,
    });

    const unsafe = loadConfig({
      X402_ENABLE_AGENT_CREATION: "1",
      X402_ENABLE_PAPER_AGENTS: "1",
      X402_PUBLIC_BETA_BACKEND_SIGNING: "1",
      X402_PUBLIC_BETA_BACKEND_CUSTODY: "1",
    });
    expect(validateRuntimeGateConfig(unsafe)).toEqual(expect.arrayContaining([
      "X402_PUBLIC_BETA_BACKEND_SIGNING must remain 0; backend signing is never allowed.",
      "X402_PUBLIC_BETA_BACKEND_CUSTODY must remain 0; backend custody is never allowed.",
      "X402_ENABLE_PUBLIC_BETA=1 is required before enabling Public Beta agent features.",
    ]));

    const publicBeta = loadConfig({
      X402_ENABLE_PUBLIC_BETA: "1",
      X402_PUBLIC_BETA_GATE_REF: "PUBLIC_BETA_AGENT_PILOT_2026",
      X402_ENABLE_AGENT_CREATION: "1",
      X402_ENABLE_PAPER_AGENTS: "1",
      X402_ENABLE_PUBLIC_AGENT_PROFILES: "1",
      X402_ENABLE_COPY_SETTINGS: "1",
      X402_ENABLE_ALPHA_MONETIZATION: "1",
    });
    expect(validateRuntimeGateConfig(publicBeta)).toEqual([]);
    expect(publicBeta.publicBeta).toMatchObject({
      enabled: true,
      gateRef: "PUBLIC_BETA_AGENT_PILOT_2026",
      agentCreation: true,
      paperAgents: true,
      publicAgentProfiles: true,
      copySettings: true,
      alphaMonetization: true,
    });
  });

  it("allows only capped, client-signed, monitored low-risk Public Beta live flows", () => {
    const unsafe = loadConfig({
      X402_ENABLE_PUBLIC_BETA: "1",
      X402_PUBLIC_BETA_GATE_REF: "PUBLIC_BETA_AGENT_PILOT_2026",
      X402_ENABLE_PUBLIC_BETA_LIVE_LOW_RISK: "1",
      X402_PUBLIC_BETA_MAX_TX_USD: "201",
      X402_PUBLIC_BETA_MAX_DAILY_SPEND_USD: "1501",
      X402_PUBLIC_BETA_MAX_DAILY_LOSS_USD: "301",
      X402_PUBLIC_BETA_MAX_OPEN_EXPOSURE_USD: "501",
      X402_ENABLE_POLYMARKET_LIVE: "1",
    });
    expect(validateRuntimeGateConfig(unsafe)).toEqual(expect.arrayContaining([
      "X402_PUBLIC_BETA_REQUIRE_CLIENT_SIGNATURE=1 is required for capped live beta flows.",
      "X402_ENABLE_DIRECT_SPLIT_FEES=1 is required for Public Beta live paid flows.",
      "X402_PLATFORM_FEE_MODE=direct_split is required for Public Beta live paid flows.",
      "X402_DIRECT_SPLIT_GATE_REF is required for Public Beta live paid flows.",
      "X402_PLATFORM_FEE_TREASURY is required for Public Beta live paid flows.",
      "Legacy FEE_BPS/BASE_FEE_ATOMIC/MIN_FEE_ATOMIC must be zero for Public Beta live paid direct split flows.",
      "X402_PUBLIC_BETA_MAX_TX_USD cannot exceed 200 without a new beta risk review.",
      "X402_PUBLIC_BETA_MAX_DAILY_SPEND_USD cannot exceed 1500 without a new beta risk review.",
      "X402_PUBLIC_BETA_MAX_DAILY_LOSS_USD cannot exceed 300 without a new beta risk review.",
      "X402_PUBLIC_BETA_MAX_OPEN_EXPOSURE_USD cannot exceed 500 without a new beta risk review.",
      "Telegram alerts must be enabled before Public Beta capped live flows.",
      "Dangerous runtime gates must remain disabled for Public Beta capped live flows.",
    ]));

    const safe = loadConfig({
      X402_ENABLE_PUBLIC_BETA: "1",
      X402_PUBLIC_BETA_GATE_REF: "PUBLIC_BETA_AGENT_PILOT_2026",
      X402_ENABLE_AGENT_CREATION: "1",
      X402_ENABLE_PAPER_AGENTS: "1",
      X402_ENABLE_PUBLIC_AGENT_PROFILES: "1",
      X402_ENABLE_COPY_SETTINGS: "1",
      X402_ENABLE_ALPHA_MONETIZATION: "1",
      X402_ENABLE_PUBLIC_BETA_LIVE_LOW_RISK: "1",
      X402_PUBLIC_BETA_REQUIRE_CLIENT_SIGNATURE: "1",
      X402_PUBLIC_BETA_MAX_TX_USD: "200",
      X402_PUBLIC_BETA_MAX_DAILY_SPEND_USD: "1500",
      X402_PUBLIC_BETA_MAX_DAILY_LOSS_USD: "300",
      X402_PUBLIC_BETA_MAX_OPEN_EXPOSURE_USD: "500",
      X402_ENABLE_DIRECT_SPLIT_FEES: "1",
      X402_DIRECT_SPLIT_GATE_REF: "PUBLIC_BETA_DIRECT_SPLIT_2026",
      X402_PLATFORM_FEE_MODE: "direct_split",
      X402_PLATFORM_FEE_BPS: "10",
      X402_PLATFORM_FEE_TREASURY: "dna-treasury",
      FEE_BPS: "0",
      BASE_FEE_ATOMIC: "0",
      MIN_FEE_ATOMIC: "0",
      X402_ALERT_TELEGRAM_ENABLED: "1",
      X402_ALERT_TELEGRAM_BOT_TOKEN: "telegram-bot-token-redacted",
      X402_ALERT_TELEGRAM_CHAT_ID: "-100123456789",
      X402_ALERT_TELEGRAM_RELAY_SECRET: "0123456789abcdef01234567",
    });
    expect(validateRuntimeGateConfig(safe)).toEqual([]);
    expect(safe.publicBeta).toMatchObject({
      liveLowRisk: true,
      requireClientSignature: true,
      maxTxUsd: 200,
      maxDailySpendUsd: 1500,
      maxDailyLossUsd: 300,
      maxOpenExposureUsd: 500,
    });
  });
});
