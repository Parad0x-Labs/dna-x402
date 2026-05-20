import "dotenv/config";
import { z } from "zod";
import { FeePolicy, parseAtomic } from "./feePolicy.js";
import type { DnaGuardSpendCeilings } from "./guard/engine.js";

const DEFAULT_USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEFAULT_DEVNET_PAYMENT_RECIPIENT = "CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2";
export const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MIN_PRODUCTION_SECRET_LENGTH = 24;
export const PUBLIC_BETA_RISK_CAPS_USD = {
  maxTxUsd: 200,
  maxDailySpendUsd: 1500,
  maxDailyLossUsd: 300,
  maxOpenExposureUsd: 500,
} as const;

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  CLUSTER: z.string().default("devnet"),
  PORT: z.coerce.number().int().positive().default(8080),
  APP_VERSION: z.string().default("dev"),
  BUILD_COMMIT: z.string().optional(),
  SOLANA_RPC_URL: z.string().url().default("https://api.devnet.solana.com"),
  PDX_DARK_PROTOCOL_PROGRAM_ID: z.string().min(32).optional(),
  PAYMENT_PROGRAM_ID: z.string().min(32).optional(),
  USDC_MINT: z.string().min(32).default(DEFAULT_USDC_DEVNET),
  PAYMENT_RECIPIENT: z.string().min(32).default(DEFAULT_DEVNET_PAYMENT_RECIPIENT),
  DEFAULT_CURRENCY: z.literal("USDC").default("USDC"),
  ENABLED_PRICING_MODELS: z.string().default("flat,surge,stream"),
  MARKETPLACE_SELECTION: z.string().default("cheapest_sla_else_limit_order"),
  BASE_FEE_ATOMIC: z.string().regex(/^\d+$/).default("0"),
  FEE_BPS: z.coerce.number().int().min(0).max(10000).default(30),
  MIN_FEE_ATOMIC: z.string().regex(/^\d+$/).default("0"),
  ACCRUE_THRESHOLD_ATOMIC: z.string().regex(/^\d+$/).default("1000"),
  MIN_SETTLE_ATOMIC: z.string().regex(/^\d+$/).default("0"),
  NETTING_THRESHOLD_ATOMIC: z.string().regex(/^\d+$/).default("1000"),
  NETTING_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  UNSAFE_UNVERIFIED_NETTING_ENABLED: z.string().optional(),
  QUOTE_TTL_SECONDS: z.coerce.number().int().positive().default(180),
  RECEIPT_SIGNING_SECRET: z.string().optional(),
  ANCHORING_ENABLED: z.string().optional(),
  RECEIPT_ANCHOR_PROGRAM_ID: z.string().min(32).optional(),
  ANCHORING_KEYPAIR_PATH: z.string().optional(),
  ANCHORING_ALT_ADDRESS: z.string().min(32).optional(),
  ANCHORING_FLUSH_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  ANCHORING_BATCH_SIZE: z.coerce.number().int().min(1).max(32).default(32),
  ANCHORING_IMMEDIATE: z.string().optional(),
  ANCHORING_SIGNATURE_LOG_PATH: z.string().optional(),
  PAUSE_MARKET: z.string().optional(),
  PAUSE_FINALIZE: z.string().optional(),
  PAUSE_ORDERS: z.string().optional(),
  AUDIT_FIXTURES: z.string().optional(),
  GAUNTLET_MODE: z.string().optional(),
  DEVNET_GAUNTLET_MINT: z.string().min(32).optional(),
  ALLOW_INSECURE: z.string().optional(),
  PARTNER_TOKEN: z.string().optional(),
  PARTNER_HMAC_SECRET: z.string().optional(),
  DISABLED_SHOPS: z.string().optional(),
  AUTO_DISABLE_REPORT_THRESHOLD: z.coerce.number().int().nonnegative().default(0),
  ADMIN_SECRET: z.string().optional(),
  AUDIT_LOG_PATH: z.string().optional(),
  WEBHOOK_SIGNING_SECRET: z.string().optional(),
  X402_ALERT_TELEGRAM_ENABLED: z.string().optional(),
  X402_ALERT_TELEGRAM_BOT_TOKEN: z.string().optional(),
  X402_ALERT_TELEGRAM_CHAT_ID: z.string().optional(),
  X402_ALERT_TELEGRAM_PARSE_MODE: z.enum(["HTML", "MarkdownV2"]).default("HTML"),
  X402_ALERT_TELEGRAM_RELAY_SECRET: z.string().optional(),
  X402_ALERT_TELEGRAM_COMMANDS_ENABLED: z.string().optional(),
  X402_ALERT_TELEGRAM_ALLOWED_USER_IDS: z.string().optional(),
  X402_ALERT_TELEGRAM_ALLOWED_ADMIN_IDS: z.string().optional(),
  X402_ALERT_TELEGRAM_ALLOWED_CHAT_IDS: z.string().optional(),
  X402_ALERT_TELEGRAM_STATUS_METRICS_URL: z.string().url().default("http://127.0.0.1:8080/metrics"),
  DATABASE_URL: z.string().optional(),
  X402_DATABASE_URL: z.string().optional(),
  X402_DB_DRIVER: z.string().optional(),
  X402_REPOSITORY_MODE: z.string().optional(),
  POLICY_VERSION: z.string().default("policy-v1"),
  X402_ENABLE_PROD_MONEY: z.string().optional(),
  X402_ENABLE_POLYMARKET_LIVE: z.string().optional(),
  X402_ENABLE_PUBLIC_NETTING: z.string().optional(),
  X402_ENABLE_PHYSICAL_GOODS: z.string().optional(),
  X402_ENABLE_HIGH_RISK_CATEGORIES: z.string().optional(),
  X402_ENABLE_MULTI_CHAIN_SETTLEMENT: z.string().optional(),
  X402_ENABLE_UNATTENDED_SIGNING: z.string().optional(),
  X402_ENABLE_BACKEND_KEY_CUSTODY: z.string().optional(),
  X402_ENABLE_PUBLIC_MARKETPLACE: z.string().optional(),
  X402_ENABLE_WEBHOOK_DELIVERY: z.string().optional(),
  X402_ENABLE_FINALIZE: z.string().optional(),
  X402_ENABLE_QUOTES: z.string().optional(),
  X402_ENABLE_WEBHOOK_RECEIVER_TEST: z.string().optional(),
  X402_ENABLE_REAL_CHAIN_DRILL: z.string().optional(),
  X402_REAL_CHAIN_ALLOWED_SIGNERS: z.string().optional(),
  X402_REAL_CHAIN_MAX_TX_ATOMIC: z.string().regex(/^\d+$/).optional(),
  X402_REAL_CHAIN_DAILY_CAP_ATOMIC: z.string().regex(/^\d+$/).optional(),
  X402_REAL_CHAIN_FEE_MODE: z.enum(["none", "display_only", "direct_split", "seller_accrual"]).default("none"),
  X402_REAL_CHAIN_PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(0),
  X402_REAL_CHAIN_PLATFORM_RECIPIENT: z.string().optional(),
  X402_PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(10),
  X402_PLATFORM_FEE_MODE: z.enum(["off", "display_only", "seller_accrual", "direct_split"]).default("display_only"),
  X402_PLATFORM_FEE_TREASURY: z.string().optional(),
  X402_ENABLE_BUILDER_FEES: z.string().optional(),
  X402_BUILDER_FEE_DEFAULT_MODE: z.enum(["display_only", "builder_accrual", "direct_split"]).default("display_only"),
  X402_BUILDER_FEE_MAX_BPS: z.coerce.number().int().min(0).max(10_000).default(500),
  X402_ENABLE_AFFILIATE_FEES: z.string().optional(),
  X402_AFFILIATE_FEE_MAX_BPS: z.coerce.number().int().min(0).max(10_000).default(200),
  X402_ENABLE_DIRECT_SPLIT_FEES: z.string().optional(),
  X402_DIRECT_SPLIT_GATE_REF: z.string().optional(),
  X402_ENABLE_AUTO_SWEEP: z.string().optional(),
  X402_AUTO_SWEEP_THRESHOLD_SOL: z.string().optional(),
  X402_ENABLE_PUBLIC_BETA: z.string().optional(),
  X402_PUBLIC_BETA_GATE_REF: z.string().optional(),
  X402_ENABLE_AGENT_CREATION: z.string().optional(),
  X402_ENABLE_PAPER_AGENTS: z.string().optional(),
  X402_ENABLE_PUBLIC_AGENT_PROFILES: z.string().optional(),
  X402_ENABLE_COPY_SETTINGS: z.string().optional(),
  X402_ENABLE_ALPHA_MONETIZATION: z.string().optional(),
  X402_ENABLE_PUBLIC_BETA_LIVE_LOW_RISK: z.string().optional(),
  X402_PUBLIC_BETA_REQUIRE_CLIENT_SIGNATURE: z.string().optional(),
  X402_PUBLIC_BETA_BACKEND_SIGNING: z.string().optional(),
  X402_PUBLIC_BETA_BACKEND_CUSTODY: z.string().optional(),
  X402_PUBLIC_BETA_MAX_TX_USD: z.coerce.number().positive().default(PUBLIC_BETA_RISK_CAPS_USD.maxTxUsd),
  X402_PUBLIC_BETA_MAX_DAILY_SPEND_USD: z.coerce.number().positive().default(PUBLIC_BETA_RISK_CAPS_USD.maxDailySpendUsd),
  X402_PUBLIC_BETA_MAX_DAILY_LOSS_USD: z.coerce.number().positive().default(PUBLIC_BETA_RISK_CAPS_USD.maxDailyLossUsd),
  X402_PUBLIC_BETA_MAX_OPEN_EXPOSURE_USD: z.coerce.number().positive().default(PUBLIC_BETA_RISK_CAPS_USD.maxOpenExposureUsd),
  X402_PROD_MONEY_CHECKLIST_REF: z.string().optional(),
  X402_POLYMARKET_LIVE_CHECKLIST_REF: z.string().optional(),
  X402_PUBLIC_NETTING_CHECKLIST_REF: z.string().optional(),
  X402_PHYSICAL_GOODS_CHECKLIST_REF: z.string().optional(),
  X402_HIGH_RISK_CATEGORIES_CHECKLIST_REF: z.string().optional(),
  X402_MULTI_CHAIN_SETTLEMENT_CHECKLIST_REF: z.string().optional(),
  X402_UNATTENDED_SIGNING_CHECKLIST_REF: z.string().optional(),
  X402_BACKEND_KEY_CUSTODY_CHECKLIST_REF: z.string().optional(),
  X402_PUBLIC_MARKETPLACE_CHECKLIST_REF: z.string().optional(),
  X402_WEBHOOK_DELIVERY_CHECKLIST_REF: z.string().optional(),
  PUBLIC_MARKETPLACE_ENABLED: z.string().optional(),
  LIVE_MONEY_MOVEMENT_ENABLED: z.string().optional(),
  POLYMARKET_LIVE_MOVEMENT_ENABLED: z.string().optional(),
  PUBLIC_NETTING_ENABLED: z.string().optional(),
  PUBLIC_PHYSICAL_GOODS_ENABLED: z.string().optional(),
  PUBLIC_HIGH_RISK_CATEGORIES_ENABLED: z.string().optional(),
  DNA_GUARD_ENABLED: z.string().optional(),
  DNA_GUARD_FAIL_MODE: z.enum(["fail-open", "fail-closed"]).default("fail-open"),
  DNA_GUARD_WINDOW_MS: z.coerce.number().int().positive().default(86_400_000),
  DNA_GUARD_SNAPSHOT_PATH: z.string().optional(),
  DNA_GUARD_BUYER_CEILING_ATOMIC: z.string().regex(/^\d+$/).optional(),
  DNA_GUARD_WALLET_CEILING_ATOMIC: z.string().regex(/^\d+$/).optional(),
  DNA_GUARD_AGENT_CEILING_ATOMIC: z.string().regex(/^\d+$/).optional(),
  DNA_GUARD_API_KEY_CEILING_ATOMIC: z.string().regex(/^\d+$/).optional(),
  NULL_TIP_MINT: z.string().optional(),
  NULL_TIP_VAULT_ADDRESS: z.string().optional(),
  NULL_TIP_SYMBOL: z.string().default("NULL"),
  NULL_TIP_DECIMALS: z.coerce.number().int().min(0).max(18).default(6),
  NULL_TIP_SESSION_SECRET: z.string().optional(),
  NULL_TIP_MAX_SEND_ATOMIC: z.string().regex(/^\d+$/).optional(),
  NULL_TIP_MAX_WITHDRAW_ATOMIC: z.string().regex(/^\d+$/).optional(),
});

type ParsedEnv = z.infer<typeof schema>;

export type RuntimeGateName =
  | "prodMoney"
  | "polymarketLive"
  | "publicNetting"
  | "physicalGoods"
  | "highRiskCategories"
  | "multiChainSettlement"
  | "unattendedSigning"
  | "backendKeyCustody"
  | "publicMarketplace"
  | "webhookDelivery";

export interface X402RuntimeGates {
  prodMoney: boolean;
  polymarketLive: boolean;
  publicNetting: boolean;
  physicalGoods: boolean;
  highRiskCategories: boolean;
  multiChainSettlement: boolean;
  unattendedSigning: boolean;
  backendKeyCustody: boolean;
  publicMarketplace: boolean;
  webhookDelivery: boolean;
  finalize: boolean;
  quotes: boolean;
  webhookReceiverTest: boolean;
  checklistRefs: Partial<Record<RuntimeGateName, string>>;
}

export type RealChainDrillFeeMode = "none" | "display_only" | "direct_split" | "seller_accrual";

export interface RealChainDrillConfig {
  enabled: boolean;
  allowedSigners: string[];
  maxTxAtomic?: string;
  dailyCapAtomic?: string;
  feeMode: RealChainDrillFeeMode;
  platformFeeBps: number;
  platformRecipient?: string;
}

export type BuilderFeeDefaultMode = "display_only" | "builder_accrual" | "direct_split";
export type PlatformFeeMode = "off" | "display_only" | "seller_accrual" | "direct_split";

export interface BuilderMonetizationConfig {
  platformFeeBps: number;
  platformFeeMode: PlatformFeeMode;
  platformTreasury?: string;
  builderFeesEnabled: boolean;
  builderFeeDefaultMode: BuilderFeeDefaultMode;
  builderFeeMaxBps: number;
  affiliateFeesEnabled: boolean;
  affiliateFeeMaxBps: number;
  directSplitFeesEnabled: boolean;
  directSplitGateRef?: string;
  autoSweepRequested: boolean;
  autoSweepThresholdSol?: string;
}

export interface PublicBetaConfig {
  enabled: boolean;
  gateRef?: string;
  agentCreation: boolean;
  paperAgents: boolean;
  publicAgentProfiles: boolean;
  copySettings: boolean;
  alphaMonetization: boolean;
  liveLowRisk: boolean;
  requireClientSignature: boolean;
  backendSigning: boolean;
  backendCustody: boolean;
  maxTxUsd: number;
  maxDailySpendUsd: number;
  maxDailyLossUsd: number;
  maxOpenExposureUsd: number;
}

export type X402GuardFailMode = "fail-open" | "fail-closed";

export interface X402GuardConfig {
  enabled: boolean;
  failMode: X402GuardFailMode;
  windowMs: number;
  snapshotPath?: string;
  spendCeilings: DnaGuardSpendCeilings;
}

export interface TelegramAlertRouteConfig {
  enabled: boolean;
  botToken?: string;
  chatId?: string;
  parseMode: "HTML" | "MarkdownV2";
  relaySecret?: string;
  commandsEnabled: boolean;
  allowedUserIds: string[];
  allowedAdminIds: string[];
  allowedChatIds: string[];
  statusMetricsUrl: string;
}

export interface NullTipConfig {
  tokenMint: string;
  vaultAddress?: string;
  tokenSymbol: string;
  decimals: number;
  sessionSecret?: string;
  maxSendAtomic?: string;
  maxWithdrawAtomic?: string;
}

export interface X402Config {
  nodeEnv?: string;
  cluster?: string;
  port: number;
  appVersion: string;
  buildCommit?: string;
  solanaRpcUrl: string;
  pdxDarkProtocolProgramId?: string;
  paymentProgramId?: string;
  usdcMint: string;
  paymentRecipient: string;
  defaultCurrency: "USDC";
  enabledPricingModels: string[];
  marketplaceSelection: string;
  quoteTtlSeconds: number;
  feePolicy: FeePolicy;
  nettingThresholdAtomic: bigint;
  nettingIntervalMs: number;
  unsafeUnverifiedNettingEnabled?: boolean;
  receiptSigningSecret?: string;
  anchoringEnabled?: boolean;
  receiptAnchorProgramId?: string;
  anchoringKeypairPath?: string;
  anchoringAltAddress?: string;
  anchoringFlushIntervalMs?: number;
  anchoringBatchSize?: number;
  anchoringImmediate?: boolean;
  anchoringSignatureLogPath?: string;
  pauseMarket: boolean;
  pauseFinalize: boolean;
  pauseOrders: boolean;
  auditFixtures?: boolean;
  gauntletMode?: boolean;
  allowInsecure?: boolean;
  partnerToken?: string;
  partnerHmacSecret?: string;
  disabledShops: string[];
  autoDisableReportThreshold: number;
  adminSecret?: string;
  auditLogPath?: string;
  webhookSigningSecret?: string;
  telegramAlerts?: TelegramAlertRouteConfig;
  databaseUrl?: string;
  dbDriver?: string;
  repositoryMode?: string;
  policyVersion?: string;
  runtimeGates?: X402RuntimeGates;
  publicMarketplaceEnabled?: boolean;
  liveMoneyMovementEnabled?: boolean;
  polymarketLiveMovementEnabled?: boolean;
  publicNettingEnabled?: boolean;
  publicPhysicalGoodsEnabled?: boolean;
  publicHighRiskCategoriesEnabled?: boolean;
  multiChainSettlementEnabled?: boolean;
  unattendedSigningEnabled?: boolean;
  backendKeyCustodyEnabled?: boolean;
  webhookDeliveryEnabled?: boolean;
  finalizeEnabled?: boolean;
  quotesEnabled?: boolean;
  webhookReceiverTestEnabled?: boolean;
  realChainDrill?: RealChainDrillConfig;
  builderMonetization?: BuilderMonetizationConfig;
  publicBeta?: PublicBetaConfig;
  dnaGuard?: X402GuardConfig;
  nullTips?: NullTipConfig;
}

function parseBooleanEnv(value: string | undefined, fallback = false): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseGateFlag(primary: string | undefined, legacy: string | undefined, fallback = false): boolean {
  return parseBooleanEnv(primary ?? legacy, fallback);
}

function defaultRuntimeGates(): X402RuntimeGates {
  return {
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
    checklistRefs: {},
  };
}

function normalizeRuntimeGates(parsed: ParsedEnv): X402RuntimeGates {
  return {
    prodMoney: parseGateFlag(parsed.X402_ENABLE_PROD_MONEY, parsed.LIVE_MONEY_MOVEMENT_ENABLED),
    polymarketLive: parseGateFlag(parsed.X402_ENABLE_POLYMARKET_LIVE, parsed.POLYMARKET_LIVE_MOVEMENT_ENABLED),
    publicNetting: parseGateFlag(parsed.X402_ENABLE_PUBLIC_NETTING, parsed.PUBLIC_NETTING_ENABLED),
    physicalGoods: parseGateFlag(parsed.X402_ENABLE_PHYSICAL_GOODS, parsed.PUBLIC_PHYSICAL_GOODS_ENABLED),
    highRiskCategories: parseGateFlag(
      parsed.X402_ENABLE_HIGH_RISK_CATEGORIES,
      parsed.PUBLIC_HIGH_RISK_CATEGORIES_ENABLED
    ),
    multiChainSettlement: parseGateFlag(parsed.X402_ENABLE_MULTI_CHAIN_SETTLEMENT, undefined),
    unattendedSigning: parseGateFlag(parsed.X402_ENABLE_UNATTENDED_SIGNING, undefined),
    backendKeyCustody: parseGateFlag(parsed.X402_ENABLE_BACKEND_KEY_CUSTODY, undefined),
    publicMarketplace: parseGateFlag(parsed.X402_ENABLE_PUBLIC_MARKETPLACE, parsed.PUBLIC_MARKETPLACE_ENABLED),
    webhookDelivery: parseGateFlag(parsed.X402_ENABLE_WEBHOOK_DELIVERY, undefined),
    finalize: parseGateFlag(parsed.X402_ENABLE_FINALIZE, undefined, true),
    quotes: parseGateFlag(parsed.X402_ENABLE_QUOTES, undefined, true),
    webhookReceiverTest: parseGateFlag(parsed.X402_ENABLE_WEBHOOK_RECEIVER_TEST, undefined),
    checklistRefs: {
      prodMoney: parsed.X402_PROD_MONEY_CHECKLIST_REF,
      polymarketLive: parsed.X402_POLYMARKET_LIVE_CHECKLIST_REF,
      publicNetting: parsed.X402_PUBLIC_NETTING_CHECKLIST_REF,
      physicalGoods: parsed.X402_PHYSICAL_GOODS_CHECKLIST_REF,
      highRiskCategories: parsed.X402_HIGH_RISK_CATEGORIES_CHECKLIST_REF,
      multiChainSettlement: parsed.X402_MULTI_CHAIN_SETTLEMENT_CHECKLIST_REF,
      unattendedSigning: parsed.X402_UNATTENDED_SIGNING_CHECKLIST_REF,
      backendKeyCustody: parsed.X402_BACKEND_KEY_CUSTODY_CHECKLIST_REF,
      publicMarketplace: parsed.X402_PUBLIC_MARKETPLACE_CHECKLIST_REF,
      webhookDelivery: parsed.X402_WEBHOOK_DELIVERY_CHECKLIST_REF,
    },
  };
}

function parseCsv(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeRealChainDrill(parsed: ParsedEnv): RealChainDrillConfig {
  return {
    enabled: parseBooleanEnv(parsed.X402_ENABLE_REAL_CHAIN_DRILL, false),
    allowedSigners: parseCsv(parsed.X402_REAL_CHAIN_ALLOWED_SIGNERS),
    maxTxAtomic: parsed.X402_REAL_CHAIN_MAX_TX_ATOMIC,
    dailyCapAtomic: parsed.X402_REAL_CHAIN_DAILY_CAP_ATOMIC,
    feeMode: parsed.X402_REAL_CHAIN_FEE_MODE,
    platformFeeBps: parsed.X402_REAL_CHAIN_PLATFORM_FEE_BPS,
    platformRecipient: parsed.X402_REAL_CHAIN_PLATFORM_RECIPIENT,
  };
}

function normalizeBuilderMonetization(parsed: ParsedEnv): BuilderMonetizationConfig {
  return {
    platformFeeBps: parsed.X402_PLATFORM_FEE_BPS,
    platformFeeMode: parsed.X402_PLATFORM_FEE_MODE,
    platformTreasury: parsed.X402_PLATFORM_FEE_TREASURY,
    builderFeesEnabled: parseBooleanEnv(parsed.X402_ENABLE_BUILDER_FEES, true),
    builderFeeDefaultMode: parsed.X402_BUILDER_FEE_DEFAULT_MODE,
    builderFeeMaxBps: parsed.X402_BUILDER_FEE_MAX_BPS,
    affiliateFeesEnabled: parseBooleanEnv(parsed.X402_ENABLE_AFFILIATE_FEES, false),
    affiliateFeeMaxBps: parsed.X402_AFFILIATE_FEE_MAX_BPS,
    directSplitFeesEnabled: parseBooleanEnv(parsed.X402_ENABLE_DIRECT_SPLIT_FEES, false),
    directSplitGateRef: parsed.X402_DIRECT_SPLIT_GATE_REF,
    autoSweepRequested: parseBooleanEnv(parsed.X402_ENABLE_AUTO_SWEEP, false),
    autoSweepThresholdSol: parsed.X402_AUTO_SWEEP_THRESHOLD_SOL,
  };
}

function normalizePublicBeta(parsed: ParsedEnv): PublicBetaConfig {
  return {
    enabled: parseBooleanEnv(parsed.X402_ENABLE_PUBLIC_BETA, false),
    gateRef: parsed.X402_PUBLIC_BETA_GATE_REF,
    agentCreation: parseBooleanEnv(parsed.X402_ENABLE_AGENT_CREATION, false),
    paperAgents: parseBooleanEnv(parsed.X402_ENABLE_PAPER_AGENTS, false),
    publicAgentProfiles: parseBooleanEnv(parsed.X402_ENABLE_PUBLIC_AGENT_PROFILES, false),
    copySettings: parseBooleanEnv(parsed.X402_ENABLE_COPY_SETTINGS, false),
    alphaMonetization: parseBooleanEnv(parsed.X402_ENABLE_ALPHA_MONETIZATION, false),
    liveLowRisk: parseBooleanEnv(parsed.X402_ENABLE_PUBLIC_BETA_LIVE_LOW_RISK, false),
    requireClientSignature: parseBooleanEnv(parsed.X402_PUBLIC_BETA_REQUIRE_CLIENT_SIGNATURE, false),
    backendSigning: parseBooleanEnv(parsed.X402_PUBLIC_BETA_BACKEND_SIGNING, false),
    backendCustody: parseBooleanEnv(parsed.X402_PUBLIC_BETA_BACKEND_CUSTODY, false),
    maxTxUsd: parsed.X402_PUBLIC_BETA_MAX_TX_USD,
    maxDailySpendUsd: parsed.X402_PUBLIC_BETA_MAX_DAILY_SPEND_USD,
    maxDailyLossUsd: parsed.X402_PUBLIC_BETA_MAX_DAILY_LOSS_USD,
    maxOpenExposureUsd: parsed.X402_PUBLIC_BETA_MAX_OPEN_EXPOSURE_USD,
  };
}

export function runtimeGatesForConfig(config: Partial<X402Config>): X402RuntimeGates {
  const defaults = defaultRuntimeGates();
  if (config.runtimeGates) {
    return {
      ...defaults,
      ...config.runtimeGates,
      checklistRefs: {
        ...defaults.checklistRefs,
        ...config.runtimeGates.checklistRefs,
      },
    };
  }

  return {
    ...defaults,
    prodMoney: Boolean(config.liveMoneyMovementEnabled),
    polymarketLive: Boolean(config.polymarketLiveMovementEnabled),
    publicNetting: Boolean(config.publicNettingEnabled),
    physicalGoods: Boolean(config.publicPhysicalGoodsEnabled),
    highRiskCategories: Boolean(config.publicHighRiskCategoriesEnabled),
    multiChainSettlement: Boolean(config.multiChainSettlementEnabled),
    unattendedSigning: Boolean(config.unattendedSigningEnabled),
    backendKeyCustody: Boolean(config.backendKeyCustodyEnabled),
    publicMarketplace: Boolean(config.publicMarketplaceEnabled),
    webhookDelivery: Boolean(config.webhookDeliveryEnabled),
    finalize: config.finalizeEnabled ?? true,
    quotes: config.quotesEnabled ?? true,
    webhookReceiverTest: Boolean(config.webhookReceiverTestEnabled),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): X402Config {
  const parsed = schema.parse(env);
  const runtimeGates = normalizeRuntimeGates(parsed);
  const realChainDrill = normalizeRealChainDrill(parsed);
  const builderMonetization = normalizeBuilderMonetization(parsed);
  const publicBeta = normalizePublicBeta(parsed);
  const gauntletMode = parseBooleanEnv(parsed.GAUNTLET_MODE, false);
  const cluster = parsed.CLUSTER.toLowerCase();
  const isDevnet = cluster === "devnet" || parsed.SOLANA_RPC_URL.includes("devnet");
  const effectiveMint = gauntletMode && isDevnet && parsed.DEVNET_GAUNTLET_MINT
    ? parsed.DEVNET_GAUNTLET_MINT
    : parsed.USDC_MINT;

  return {
    nodeEnv: parsed.NODE_ENV,
    cluster: parsed.CLUSTER,
    port: parsed.PORT,
    appVersion: parsed.APP_VERSION,
    buildCommit: parsed.BUILD_COMMIT,
    solanaRpcUrl: parsed.SOLANA_RPC_URL,
    pdxDarkProtocolProgramId: parsed.PDX_DARK_PROTOCOL_PROGRAM_ID ?? parsed.PAYMENT_PROGRAM_ID,
    paymentProgramId: parsed.PAYMENT_PROGRAM_ID,
    usdcMint: effectiveMint,
    paymentRecipient: parsed.PAYMENT_RECIPIENT,
    defaultCurrency: parsed.DEFAULT_CURRENCY,
    enabledPricingModels: parsed.ENABLED_PRICING_MODELS.split(",").map((model) => model.trim()).filter(Boolean),
    marketplaceSelection: parsed.MARKETPLACE_SELECTION,
    quoteTtlSeconds: parsed.QUOTE_TTL_SECONDS,
    feePolicy: {
      baseFeeAtomic: parseAtomic(parsed.BASE_FEE_ATOMIC),
      feeBps: parsed.FEE_BPS,
      minFeeAtomic: parseAtomic(parsed.MIN_FEE_ATOMIC),
      accrueThresholdAtomic: parseAtomic(parsed.ACCRUE_THRESHOLD_ATOMIC),
      minSettleAtomic: parseAtomic(parsed.MIN_SETTLE_ATOMIC),
    },
    nettingThresholdAtomic: parseAtomic(parsed.NETTING_THRESHOLD_ATOMIC),
    nettingIntervalMs: parsed.NETTING_INTERVAL_MS,
    unsafeUnverifiedNettingEnabled: parseBooleanEnv(parsed.UNSAFE_UNVERIFIED_NETTING_ENABLED, false),
    receiptSigningSecret: parsed.RECEIPT_SIGNING_SECRET,
    anchoringEnabled: parseBooleanEnv(parsed.ANCHORING_ENABLED, false),
    receiptAnchorProgramId: parsed.RECEIPT_ANCHOR_PROGRAM_ID,
    anchoringKeypairPath: parsed.ANCHORING_KEYPAIR_PATH,
    anchoringAltAddress: parsed.ANCHORING_ALT_ADDRESS,
    anchoringFlushIntervalMs: parsed.ANCHORING_FLUSH_INTERVAL_MS,
    anchoringBatchSize: parsed.ANCHORING_BATCH_SIZE,
    anchoringImmediate: parseBooleanEnv(parsed.ANCHORING_IMMEDIATE, false),
    anchoringSignatureLogPath: parsed.ANCHORING_SIGNATURE_LOG_PATH,
    pauseMarket: parseBooleanEnv(parsed.PAUSE_MARKET, false),
    pauseFinalize: parseBooleanEnv(parsed.PAUSE_FINALIZE, false),
    pauseOrders: parseBooleanEnv(parsed.PAUSE_ORDERS, false),
    auditFixtures: parseBooleanEnv(parsed.AUDIT_FIXTURES, false),
    gauntletMode,
    allowInsecure: parseBooleanEnv(parsed.ALLOW_INSECURE, false),
    partnerToken: parsed.PARTNER_TOKEN,
    partnerHmacSecret: parsed.PARTNER_HMAC_SECRET,
    disabledShops: (parsed.DISABLED_SHOPS ?? "")
      .split(",")
      .map((shop) => shop.trim())
      .filter(Boolean),
    autoDisableReportThreshold: parsed.AUTO_DISABLE_REPORT_THRESHOLD,
    adminSecret: parsed.ADMIN_SECRET,
    auditLogPath: parsed.AUDIT_LOG_PATH,
    webhookSigningSecret: parsed.WEBHOOK_SIGNING_SECRET,
    telegramAlerts: {
      enabled: parseBooleanEnv(parsed.X402_ALERT_TELEGRAM_ENABLED, false),
      botToken: parsed.X402_ALERT_TELEGRAM_BOT_TOKEN,
      chatId: parsed.X402_ALERT_TELEGRAM_CHAT_ID,
      parseMode: parsed.X402_ALERT_TELEGRAM_PARSE_MODE,
      relaySecret: parsed.X402_ALERT_TELEGRAM_RELAY_SECRET,
      commandsEnabled: parseBooleanEnv(parsed.X402_ALERT_TELEGRAM_COMMANDS_ENABLED, false),
      allowedUserIds: parseCsv(parsed.X402_ALERT_TELEGRAM_ALLOWED_USER_IDS),
      allowedAdminIds: parseCsv(parsed.X402_ALERT_TELEGRAM_ALLOWED_ADMIN_IDS),
      allowedChatIds: parseCsv(parsed.X402_ALERT_TELEGRAM_ALLOWED_CHAT_IDS),
      statusMetricsUrl: parsed.X402_ALERT_TELEGRAM_STATUS_METRICS_URL,
    },
    databaseUrl: parsed.X402_DATABASE_URL ?? parsed.DATABASE_URL,
    dbDriver: parsed.X402_DB_DRIVER,
    repositoryMode: parsed.X402_REPOSITORY_MODE,
    policyVersion: parsed.POLICY_VERSION,
    runtimeGates,
    publicMarketplaceEnabled: runtimeGates.publicMarketplace,
    liveMoneyMovementEnabled: runtimeGates.prodMoney,
    polymarketLiveMovementEnabled: runtimeGates.polymarketLive,
    publicNettingEnabled: runtimeGates.publicNetting,
    publicPhysicalGoodsEnabled: runtimeGates.physicalGoods,
    publicHighRiskCategoriesEnabled: runtimeGates.highRiskCategories,
    multiChainSettlementEnabled: runtimeGates.multiChainSettlement,
    unattendedSigningEnabled: runtimeGates.unattendedSigning,
    backendKeyCustodyEnabled: runtimeGates.backendKeyCustody,
    webhookDeliveryEnabled: runtimeGates.webhookDelivery,
    finalizeEnabled: runtimeGates.finalize,
    quotesEnabled: runtimeGates.quotes,
    webhookReceiverTestEnabled: runtimeGates.webhookReceiverTest,
    realChainDrill,
    builderMonetization,
    publicBeta,
    dnaGuard: {
      enabled: parseBooleanEnv(parsed.DNA_GUARD_ENABLED, false),
      failMode: parsed.DNA_GUARD_FAIL_MODE,
      windowMs: parsed.DNA_GUARD_WINDOW_MS,
      snapshotPath: parsed.DNA_GUARD_SNAPSHOT_PATH,
      spendCeilings: {
        buyerAtomic: parsed.DNA_GUARD_BUYER_CEILING_ATOMIC,
        walletAtomic: parsed.DNA_GUARD_WALLET_CEILING_ATOMIC,
        agentAtomic: parsed.DNA_GUARD_AGENT_CEILING_ATOMIC,
        apiKeyAtomic: parsed.DNA_GUARD_API_KEY_CEILING_ATOMIC,
      },
    },
    nullTips: {
      tokenMint: parsed.NULL_TIP_MINT ?? "NULL_MINT_NOT_CONFIGURED",
      vaultAddress: parsed.NULL_TIP_VAULT_ADDRESS,
      tokenSymbol: parsed.NULL_TIP_SYMBOL,
      decimals: parsed.NULL_TIP_DECIMALS,
      sessionSecret: parsed.NULL_TIP_SESSION_SECRET ?? parsed.ADMIN_SECRET ?? parsed.RECEIPT_SIGNING_SECRET,
      maxSendAtomic: parsed.NULL_TIP_MAX_SEND_ATOMIC,
      maxWithdrawAtomic: parsed.NULL_TIP_MAX_WITHDRAW_ATOMIC,
    },
  };
}

export function isMainnetConfig(config: Pick<X402Config, "cluster" | "solanaRpcUrl">): boolean {
  const cluster = (config.cluster ?? "").toLowerCase();
  const rpcUrl = config.solanaRpcUrl.toLowerCase();
  return cluster.includes("mainnet") || rpcUrl.includes("mainnet");
}

export function validateRuntimeGateConfig(config: Partial<X402Config>): string[] {
  const gates = runtimeGatesForConfig(config);
  const nodeEnv = (config.nodeEnv ?? "development").toLowerCase();
  const productionLike = nodeEnv === "production" || (
    typeof config.solanaRpcUrl === "string" && isMainnetConfig(config as Pick<X402Config, "cluster" | "solanaRpcUrl">)
  );
  const issues: string[] = [];

  if (gates.backendKeyCustody) {
    issues.push("X402_ENABLE_BACKEND_KEY_CUSTODY is hard-disabled; backend private key custody is forbidden.");
  }

  if (gates.unattendedSigning) {
    issues.push("X402_ENABLE_UNATTENDED_SIGNING is hard-disabled; unattended live signing is forbidden in this pass.");
  }

  if (gates.webhookReceiverTest && nodeEnv === "production") {
    issues.push("X402_ENABLE_WEBHOOK_RECEIVER_TEST must be disabled in production.");
  }

  if (gates.webhookReceiverTest && gates.prodMoney) {
    issues.push("X402_ENABLE_WEBHOOK_RECEIVER_TEST requires live money movement to stay disabled.");
  }

  if (config.telegramAlerts?.enabled) {
    if (!config.telegramAlerts.botToken) {
      issues.push("X402_ALERT_TELEGRAM_BOT_TOKEN is required when Telegram alerts are enabled.");
    }
    if (!config.telegramAlerts.chatId) {
      issues.push("X402_ALERT_TELEGRAM_CHAT_ID is required when Telegram alerts are enabled.");
    }
    if (!config.telegramAlerts.relaySecret || config.telegramAlerts.relaySecret.length < MIN_PRODUCTION_SECRET_LENGTH) {
      issues.push(`X402_ALERT_TELEGRAM_RELAY_SECRET must be set and at least ${MIN_PRODUCTION_SECRET_LENGTH} characters when Telegram alerts are enabled.`);
    }
    if (config.telegramAlerts.commandsEnabled) {
      if (config.telegramAlerts.allowedUserIds.length === 0 && config.telegramAlerts.allowedAdminIds.length === 0) {
        issues.push("X402_ALERT_TELEGRAM_ALLOWED_USER_IDS or X402_ALERT_TELEGRAM_ALLOWED_ADMIN_IDS is required when Telegram commands are enabled.");
      }
      if (config.telegramAlerts.allowedChatIds.length === 0) {
        issues.push("X402_ALERT_TELEGRAM_ALLOWED_CHAT_IDS is required when Telegram commands are enabled.");
      }
    }
  }

  const drill = config.realChainDrill;
  if (drill?.enabled) {
    if (nodeEnv === "production") {
      issues.push("X402_ENABLE_REAL_CHAIN_DRILL is private-staging only and must be disabled in production.");
    }
    if (gates.prodMoney) {
      issues.push("X402_ENABLE_REAL_CHAIN_DRILL requires X402_ENABLE_PROD_MONEY to remain disabled.");
    }
    if (gates.publicMarketplace) {
      issues.push("X402_ENABLE_REAL_CHAIN_DRILL requires public marketplace to remain disabled.");
    }
    if (drill.allowedSigners.length === 0) {
      issues.push("X402_REAL_CHAIN_ALLOWED_SIGNERS must include at least one allowlisted signer wallet.");
    }
    if (!drill.maxTxAtomic) {
      issues.push("X402_REAL_CHAIN_MAX_TX_ATOMIC must be set for dust-size drill limits.");
    }
    if (!drill.dailyCapAtomic) {
      issues.push("X402_REAL_CHAIN_DAILY_CAP_ATOMIC must be set for dust-size drill limits.");
    }
    if (drill.feeMode === "direct_split" && !config.builderMonetization?.directSplitFeesEnabled) {
      issues.push("X402_REAL_CHAIN_FEE_MODE=direct_split requires X402_ENABLE_DIRECT_SPLIT_FEES=1.");
    }
    if (drill.feeMode === "none" && drill.platformFeeBps !== 0) {
      issues.push("X402_REAL_CHAIN_PLATFORM_FEE_BPS must be 0 when fee mode is none.");
    }
    if (drill.feeMode !== "none" && drill.platformFeeBps !== 10) {
      issues.push("Real-chain fee drill must use exactly 10 bps when fee display/accrual is enabled.");
    }
    if (drill.feeMode !== "none" && !drill.platformRecipient) {
      issues.push("X402_REAL_CHAIN_PLATFORM_RECIPIENT must be set when fee display/accrual is enabled.");
    }
  }

  const builder = config.builderMonetization;
  if (builder) {
    if (builder.autoSweepRequested || builder.autoSweepThresholdSol) {
      issues.push("Auto-sweep and SOL-equivalent fee thresholds are forbidden; fees must be display/accrual or gated direct split.");
    }
    if (builder.platformFeeMode !== "off" && builder.platformFeeMode !== "display_only" && builder.platformFeeBps > 0 && !builder.platformTreasury) {
      issues.push("X402_PLATFORM_FEE_TREASURY is required when DNA platform fee accrual or direct split is enabled.");
    }
    if (builder.platformFeeMode === "direct_split" && !builder.directSplitFeesEnabled) {
      issues.push("X402_PLATFORM_FEE_MODE=direct_split requires X402_ENABLE_DIRECT_SPLIT_FEES=1.");
    }
    if (builder.builderFeeDefaultMode === "direct_split" && !builder.directSplitFeesEnabled) {
      issues.push("X402_BUILDER_FEE_DEFAULT_MODE=direct_split requires X402_ENABLE_DIRECT_SPLIT_FEES=1.");
    }
    if (builder.directSplitFeesEnabled && !builder.directSplitGateRef) {
      issues.push("X402_DIRECT_SPLIT_GATE_REF is required before enabling direct split fees.");
    }
    if (builder.platformFeeMode === "direct_split" && builder.platformFeeBps !== 10) {
      issues.push("DNA platform direct split must use exactly 10 bps for the current Public Beta direct split gate.");
    }
    if (builder.platformFeeMode === "direct_split" && config.feePolicy && (
      config.feePolicy.baseFeeAtomic > 0n
      || config.feePolicy.feeBps > 0
      || config.feePolicy.minFeeAtomic > 0n
    )) {
      issues.push("Legacy FEE_BPS/BASE_FEE_ATOMIC/MIN_FEE_ATOMIC must be zero when direct split platform fees are enabled.");
    }
    if (builder.directSplitFeesEnabled && productionLike) {
      if (!config.telegramAlerts?.enabled) {
        issues.push("Telegram alerts must be enabled before production-like direct split fee collection.");
      }
      if (!config.solanaRpcUrl?.toLowerCase().includes("helius")) {
        issues.push("Helius RPC is required before production-like direct split fee collection.");
      }
      if (!gates.prodMoney) {
        if (!drill?.enabled) {
          issues.push("X402_ENABLE_REAL_CHAIN_DRILL must be enabled for allowlisted Public Beta direct split collection.");
        }
        if (!drill?.allowedSigners.length) {
          issues.push("X402_REAL_CHAIN_ALLOWED_SIGNERS must be set for Public Beta direct split collection.");
        }
        if (!drill?.maxTxAtomic || !drill.dailyCapAtomic) {
          issues.push("X402_REAL_CHAIN_MAX_TX_ATOMIC and X402_REAL_CHAIN_DAILY_CAP_ATOMIC are required for Public Beta direct split collection.");
        }
      }
    }
    if (builder.builderFeeMaxBps > 500) {
      issues.push("X402_BUILDER_FEE_MAX_BPS cannot exceed 500 bps without a new risk review.");
    }
    if (builder.affiliateFeesEnabled && builder.affiliateFeeMaxBps > 200) {
      issues.push("X402_AFFILIATE_FEE_MAX_BPS cannot exceed 200 bps without a new risk review.");
    }
  }

  const publicBeta = config.publicBeta;
  if (publicBeta) {
    const betaFeatures = [
      publicBeta.agentCreation,
      publicBeta.paperAgents,
      publicBeta.publicAgentProfiles,
      publicBeta.copySettings,
      publicBeta.alphaMonetization,
      publicBeta.liveLowRisk,
    ];
    if (publicBeta.backendSigning) {
      issues.push("X402_PUBLIC_BETA_BACKEND_SIGNING must remain 0; backend signing is never allowed.");
    }
    if (publicBeta.backendCustody) {
      issues.push("X402_PUBLIC_BETA_BACKEND_CUSTODY must remain 0; backend custody is never allowed.");
    }
    if (betaFeatures.some(Boolean) && !publicBeta.enabled) {
      issues.push("X402_ENABLE_PUBLIC_BETA=1 is required before enabling Public Beta agent features.");
    }
    if (publicBeta.enabled && !publicBeta.gateRef) {
      issues.push("X402_PUBLIC_BETA_GATE_REF is required before enabling Public Beta Pilot.");
    }
    if (publicBeta.liveLowRisk) {
      if (!publicBeta.requireClientSignature) {
        issues.push("X402_PUBLIC_BETA_REQUIRE_CLIENT_SIGNATURE=1 is required for capped live beta flows.");
      }
      if (!builder) {
        issues.push("Builder monetization config is required for Public Beta live paid flows.");
      } else {
        if (!builder.directSplitFeesEnabled) {
          issues.push("X402_ENABLE_DIRECT_SPLIT_FEES=1 is required for Public Beta live paid flows.");
        }
        if (builder.platformFeeMode !== "direct_split") {
          issues.push("X402_PLATFORM_FEE_MODE=direct_split is required for Public Beta live paid flows.");
        }
        if (!builder.directSplitGateRef) {
          issues.push("X402_DIRECT_SPLIT_GATE_REF is required for Public Beta live paid flows.");
        }
        if (!builder.platformTreasury) {
          issues.push("X402_PLATFORM_FEE_TREASURY is required for Public Beta live paid flows.");
        }
        if (builder.platformFeeBps !== 10) {
          issues.push("X402_PLATFORM_FEE_BPS must be exactly 10 for Public Beta live paid flows.");
        }
        if (config.feePolicy && (
          config.feePolicy.baseFeeAtomic > 0n
          || config.feePolicy.feeBps > 0
          || config.feePolicy.minFeeAtomic > 0n
        )) {
          issues.push("Legacy FEE_BPS/BASE_FEE_ATOMIC/MIN_FEE_ATOMIC must be zero for Public Beta live paid direct split flows.");
        }
      }
      if (publicBeta.maxTxUsd > PUBLIC_BETA_RISK_CAPS_USD.maxTxUsd) {
        issues.push(`X402_PUBLIC_BETA_MAX_TX_USD cannot exceed ${PUBLIC_BETA_RISK_CAPS_USD.maxTxUsd} without a new beta risk review.`);
      }
      if (publicBeta.maxDailySpendUsd > PUBLIC_BETA_RISK_CAPS_USD.maxDailySpendUsd) {
        issues.push(`X402_PUBLIC_BETA_MAX_DAILY_SPEND_USD cannot exceed ${PUBLIC_BETA_RISK_CAPS_USD.maxDailySpendUsd} without a new beta risk review.`);
      }
      if (publicBeta.maxDailyLossUsd > PUBLIC_BETA_RISK_CAPS_USD.maxDailyLossUsd) {
        issues.push(`X402_PUBLIC_BETA_MAX_DAILY_LOSS_USD cannot exceed ${PUBLIC_BETA_RISK_CAPS_USD.maxDailyLossUsd} without a new beta risk review.`);
      }
      if (publicBeta.maxOpenExposureUsd > PUBLIC_BETA_RISK_CAPS_USD.maxOpenExposureUsd) {
        issues.push(`X402_PUBLIC_BETA_MAX_OPEN_EXPOSURE_USD cannot exceed ${PUBLIC_BETA_RISK_CAPS_USD.maxOpenExposureUsd} without a new beta risk review.`);
      }
      if (!config.telegramAlerts?.enabled) {
        issues.push("Telegram alerts must be enabled before Public Beta capped live flows.");
      }
      if (gates.backendKeyCustody || gates.unattendedSigning || gates.polymarketLive || gates.publicNetting
        || gates.physicalGoods || gates.highRiskCategories || gates.multiChainSettlement) {
        issues.push("Dangerous runtime gates must remain disabled for Public Beta capped live flows.");
      }
    }
  }

  if (productionLike) {
    const requiredRefs: Array<{ name: RuntimeGateName; env: string }> = [
      { name: "prodMoney", env: "X402_PROD_MONEY_CHECKLIST_REF" },
      { name: "polymarketLive", env: "X402_POLYMARKET_LIVE_CHECKLIST_REF" },
      { name: "publicNetting", env: "X402_PUBLIC_NETTING_CHECKLIST_REF" },
      { name: "physicalGoods", env: "X402_PHYSICAL_GOODS_CHECKLIST_REF" },
      { name: "highRiskCategories", env: "X402_HIGH_RISK_CATEGORIES_CHECKLIST_REF" },
      { name: "multiChainSettlement", env: "X402_MULTI_CHAIN_SETTLEMENT_CHECKLIST_REF" },
      { name: "publicMarketplace", env: "X402_PUBLIC_MARKETPLACE_CHECKLIST_REF" },
      { name: "webhookDelivery", env: "X402_WEBHOOK_DELIVERY_CHECKLIST_REF" },
    ];

    for (const gate of requiredRefs) {
      if (gates[gate.name] && !gates.checklistRefs[gate.name]) {
        issues.push(`${gate.env} is required before enabling ${gate.name} in production-like config.`);
      }
    }
  }

  return issues;
}

export function assertRuntimeGateConfig(config: Partial<X402Config>): void {
  const issues = validateRuntimeGateConfig(config);
  if (issues.length > 0) {
    throw new Error(`Unsafe x402 runtime gate configuration:\n- ${issues.join("\n- ")}`);
  }
}

export function validateMainnetReadiness(config: X402Config): string[] {
  const issues: string[] = [];
  issues.push(...validateRuntimeGateConfig(config));

  if (!isMainnetConfig(config)) {
    return issues;
  }

  const gates = runtimeGatesForConfig(config);
  if (config.allowInsecure !== false) {
    issues.push("ALLOW_INSECURE must be disabled on mainnet.");
  }
  if (!config.adminSecret || config.adminSecret.length < MIN_PRODUCTION_SECRET_LENGTH) {
    issues.push(`ADMIN_SECRET must be set and at least ${MIN_PRODUCTION_SECRET_LENGTH} characters on mainnet.`);
  }
  if (!config.receiptSigningSecret || config.receiptSigningSecret.length < MIN_PRODUCTION_SECRET_LENGTH) {
    issues.push(`RECEIPT_SIGNING_SECRET must be set and at least ${MIN_PRODUCTION_SECRET_LENGTH} characters on mainnet.`);
  }
  if (config.usdcMint !== MAINNET_USDC_MINT) {
    issues.push(`USDC_MINT must be the canonical mainnet USDC mint ${MAINNET_USDC_MINT}.`);
  }
  if (config.paymentRecipient === DEFAULT_DEVNET_PAYMENT_RECIPIENT) {
    issues.push("PAYMENT_RECIPIENT still uses the bundled devnet recipient.");
  }
  if (config.unsafeUnverifiedNettingEnabled) {
    issues.push("UNSAFE_UNVERIFIED_NETTING_ENABLED must be disabled on mainnet.");
  }
  if (gates.prodMoney) {
    issues.push("LIVE_MONEY_MOVEMENT_ENABLED remains gated and must be disabled.");
  }
  if (gates.polymarketLive) {
    issues.push("POLYMARKET_LIVE_MOVEMENT_ENABLED remains gated and must be disabled.");
  }
  if (gates.publicNetting) {
    issues.push("PUBLIC_NETTING_ENABLED remains gated and must be disabled.");
  }
  if (gates.physicalGoods) {
    issues.push("PUBLIC_PHYSICAL_GOODS_ENABLED remains gated and must be disabled.");
  }
  if (gates.highRiskCategories) {
    issues.push("PUBLIC_HIGH_RISK_CATEGORIES_ENABLED remains gated and must be disabled.");
  }
  if (gates.multiChainSettlement) {
    issues.push("X402_ENABLE_MULTI_CHAIN_SETTLEMENT remains gated and must be disabled.");
  }
  if (gates.webhookDelivery) {
    issues.push("X402_ENABLE_WEBHOOK_DELIVERY remains gated until delivery monitoring and replay drills pass.");
  }
  if (config.auditFixtures) {
    issues.push("AUDIT_FIXTURES must be disabled on mainnet.");
  }
  if (config.gauntletMode) {
    issues.push("GAUNTLET_MODE must be disabled on mainnet.");
  }
  if (config.dnaGuard?.enabled && config.dnaGuard.failMode !== "fail-closed") {
    issues.push("DNA_GUARD_FAIL_MODE must be fail-closed when DNA Guard is enabled on mainnet.");
  }
  if (!config.anchoringEnabled) {
    issues.push("ANCHORING_ENABLED must be enabled on mainnet.");
  } else {
    if (!config.receiptAnchorProgramId) {
      issues.push("RECEIPT_ANCHOR_PROGRAM_ID must be set when anchoring is enabled on mainnet.");
    }
    if (!config.anchoringKeypairPath) {
      issues.push("ANCHORING_KEYPAIR_PATH must be set when anchoring is enabled on mainnet.");
    }
  }
  return issues;
}

export function assertMainnetReadiness(config: X402Config): void {
  const issues = validateMainnetReadiness(config);
  if (issues.length > 0) {
    throw new Error(`Mainnet readiness check failed:\n- ${issues.join("\n- ")}`);
  }
}
