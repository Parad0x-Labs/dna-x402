import "dotenv/config";
import { z } from "zod";
import { FeePolicy, parseAtomic } from "./feePolicy.js";
import type { DnaGuardSpendCeilings } from "./guard/engine.js";

const DEFAULT_USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const schema = z.object({
  CLUSTER: z.string().default("devnet"),
  PORT: z.coerce.number().int().positive().default(8080),
  APP_VERSION: z.string().default("dev"),
  BUILD_COMMIT: z.string().optional(),
  SOLANA_RPC_URL: z.string().url().default("https://api.devnet.solana.com"),
  PDX_DARK_PROTOCOL_PROGRAM_ID: z.string().min(32).optional(),
  PAYMENT_PROGRAM_ID: z.string().min(32).optional(),
  USDC_MINT: z.string().min(32).default(DEFAULT_USDC_DEVNET),
  PAYMENT_RECIPIENT: z.string().min(32).default("CsfAbvMGrYK4Ex9rKA5vFEbRR2hMBdbzjVyjjExds2d2"),
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
  DNA_GUARD_ENABLED: z.string().optional(),
  DNA_GUARD_FAIL_MODE: z.enum(["fail-open", "fail-closed"]).default("fail-open"),
  DNA_GUARD_WINDOW_MS: z.coerce.number().int().positive().default(86_400_000),
  DNA_GUARD_SNAPSHOT_PATH: z.string().optional(),
  DNA_GUARD_BUYER_CEILING_ATOMIC: z.string().regex(/^\d+$/).optional(),
  DNA_GUARD_WALLET_CEILING_ATOMIC: z.string().regex(/^\d+$/).optional(),
  DNA_GUARD_AGENT_CEILING_ATOMIC: z.string().regex(/^\d+$/).optional(),
  DNA_GUARD_API_KEY_CEILING_ATOMIC: z.string().regex(/^\d+$/).optional(),
});

export type X402GuardFailMode = "fail-open" | "fail-closed";

export interface X402GuardConfig {
  enabled: boolean;
  failMode: X402GuardFailMode;
  windowMs: number;
  snapshotPath?: string;
  spendCeilings: DnaGuardSpendCeilings;
}

export interface X402Config {
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
  dnaGuard?: X402GuardConfig;
}

function parseBooleanEnv(value: string | undefined, fallback = false): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): X402Config {
  const parsed = schema.parse(env);
  const gauntletMode = parseBooleanEnv(parsed.GAUNTLET_MODE, false);
  const cluster = parsed.CLUSTER.toLowerCase();
  const isDevnet = cluster === "devnet" || parsed.SOLANA_RPC_URL.includes("devnet");
  const effectiveMint = gauntletMode && isDevnet && parsed.DEVNET_GAUNTLET_MINT
    ? parsed.DEVNET_GAUNTLET_MINT
    : parsed.USDC_MINT;

  return {
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
    allowInsecure: parseBooleanEnv(parsed.ALLOW_INSECURE, true),
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
  };
}
