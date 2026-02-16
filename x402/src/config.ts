import "dotenv/config";
import { z } from "zod";
import { FeePolicy, parseAtomic } from "./feePolicy.js";

const DEFAULT_USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  SOLANA_RPC_URL: z.string().url().default("https://api.devnet.solana.com"),
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
  QUOTE_TTL_SECONDS: z.coerce.number().int().positive().default(180),
  RECEIPT_SIGNING_SECRET: z.string().optional(),
  PAUSE_MARKET: z.string().optional(),
  PAUSE_FINALIZE: z.string().optional(),
  PAUSE_ORDERS: z.string().optional(),
});

export interface X402Config {
  port: number;
  solanaRpcUrl: string;
  usdcMint: string;
  paymentRecipient: string;
  defaultCurrency: "USDC";
  enabledPricingModels: string[];
  marketplaceSelection: string;
  quoteTtlSeconds: number;
  feePolicy: FeePolicy;
  nettingThresholdAtomic: bigint;
  nettingIntervalMs: number;
  receiptSigningSecret?: string;
  pauseMarket: boolean;
  pauseFinalize: boolean;
  pauseOrders: boolean;
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

  return {
    port: parsed.PORT,
    solanaRpcUrl: parsed.SOLANA_RPC_URL,
    usdcMint: parsed.USDC_MINT,
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
    receiptSigningSecret: parsed.RECEIPT_SIGNING_SECRET,
    pauseMarket: parseBooleanEnv(parsed.PAUSE_MARKET, false),
    pauseFinalize: parseBooleanEnv(parsed.PAUSE_FINALIZE, false),
    pauseOrders: parseBooleanEnv(parsed.PAUSE_ORDERS, false),
  };
}
