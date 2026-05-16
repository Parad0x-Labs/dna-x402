import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { Connection } from "@solana/web3.js";
import {
  X402Config,
  X402GuardConfig,
  assertMainnetReadiness,
  assertRuntimeGateConfig,
  loadConfig,
  runtimeGatesForConfig,
} from "./config.js";
import { calculateFeeAtomic, parseAtomic, shouldUseNetting, toAtomicString } from "./feePolicy.js";
import { NettingLedger } from "./nettingLedger.js";
import { PaymentVerifier, SolanaPaymentVerifier } from "./paymentVerifier.js";
import {
  computeRequestDigest,
  computeResponseDigest,
  normalizeCommitment32B,
  ReceiptSigner,
  verifySignedReceipt,
} from "./receipts.js";
import { createMarketRouter, MarketContext } from "./market/server.js";
import { AnchoringQueue } from "./market/anchoringQueue.js";
import { ReceiptAnchorClient } from "./onchain/receiptAnchorClient.js";
import { traceIdMiddleware } from "./middleware/traceId.js";
import { requireHttpsMiddleware } from "./middleware/requireHttps.js";
import { createReplayKey, ReplayStore } from "./verifier/replayStore.js";
import { encodeCanonicalRequiredHeader, normalizeX402 } from "./x402/compat/parse.js";
import { CanonicalPaymentRequired } from "./x402/compat/types.js";
import { analyzeX402 } from "./x402/doctor.js";
import { sendX402Error } from "./x402/errorResponse.js";
import { X402Error, X402ErrorCode } from "./x402/errors.js";
import { logError, logRequestHeaders } from "./logging/logger.js";
import { AuditLogger } from "./logging/audit.js";
import { WebhookService } from "./sdk/webhook.js";
import { SignedWebhookEnvelope, verifyWebhookSignatureAndTimestamp } from "./webhooks/signed.js";
import { assertImmutableRecordSafe } from "./privacy/immutableGuard.js";
import { EmergencyPauseController } from "./emergency/state.js";
import { GovernanceService } from "./governance/service.js";
import { createAdminRouter } from "./admin/router.js";
import { adminAuth } from "./admin/auth.js";
import { createDnaGuard, DnaGuardController } from "./sdk/guard.js";
import { createFileBackedDnaGuardLedger } from "./guard/storage.js";
import { renderX402Metrics } from "./monitoring/metrics.js";
import { alertmanagerWebhookPayloadSchema, relayAlertmanagerToTelegram } from "./monitoring/telegramAlert.js";
import { PostgresDbClient } from "./db/connection.js";
import { createPostgresCommerceRepositories } from "./db/repositories.js";
import {
  BuilderFeeConfig,
  BuilderProfile,
  FeeAccrualRecord,
  FeeWaterfallV2,
  SplitPaymentProofRequirement,
  buildSplitPaymentRequirements,
  buildFeeWaterfallV2,
  createFeeAccrualRecords,
  validateSplitFinalizeRequest,
} from "./fees/waterfall.js";
import {
  AgentTradingError,
  AgentTradingRepositories,
  AgentTradingService,
  AgentWalletRegistrationInput,
  CopyDecisionInput,
  CopySettings,
  PaperTradeInput,
  SourceAgentAction,
} from "./agents/trading.js";
import {
  AgentBuilderError,
  AgentBuilderRepositories,
  AgentBuilderRequest,
  AgentBuilderService,
  AgentConfigDraft,
} from "./agents/builder/compiler.js";
import {
  CommitRecord,
  PaymentAccept,
  PaymentProof,
  PaymentRequirements,
  Quote,
  QuoteResponse,
  RealChainFeeAccrualRecord,
  ReceiptPayload,
  SettlementMode,
  SignedReceipt,
} from "./types.js";

interface CreateAppDeps {
  now?: () => Date;
  paymentVerifier?: PaymentVerifier;
  receiptSigner?: ReceiptSigner;
  nettingLedger?: NettingLedger;
  anchoringQueue?: AnchoringQueue;
  replayStore?: ReplayStore;
  auditLog?: AuditLogger;
  webhookService?: WebhookService;
  guard?: DnaGuardController;
  emergencyPause?: EmergencyPauseController;
  governance?: GovernanceService;
  webhookReplayClaimStore?: WebhookReplayClaimStore;
  feeLedgerStore?: FeeLedgerStore;
  agentTrading?: AgentTradingService;
  agentBuilder?: AgentBuilderService;
}

interface WebhookReplayClaimInput {
  idempotencyKey: string;
  event: string;
  timestamp: string;
}

interface WebhookReplayClaimStore {
  claim(input: WebhookReplayClaimInput): Promise<boolean>;
}

interface FeeLedgerStore {
  recordWaterfall(waterfall: FeeWaterfallV2): Promise<void>;
  recordAccrual(accrual: FeeAccrualRecord): Promise<void>;
}

export interface X402AppContext {
  quotes: Map<string, Quote>;
  commits: Map<string, CommitRecord>;
  receipts: Map<string, SignedReceipt>;
  receiptSigner: ReceiptSigner;
  nettingLedger: NettingLedger;
  market: MarketContext;
  anchoringQueue?: AnchoringQueue;
  replayStore: ReplayStore;
  config: X402Config;
  auditLog: AuditLogger;
  webhookService: WebhookService;
  webhookReplayClaimStore: WebhookReplayClaimStore;
  realChainFeeAccruals: RealChainFeeAccrualRecord[];
  feeAccruals: FeeAccrualRecord[];
  observedAgentIds: Set<string>;
  agentTrading: AgentTradingService;
  agentBuilder: AgentBuilderService;
  guard?: DnaGuardController;
  emergencyPause: EmergencyPauseController;
  governance: GovernanceService;
}

const quoteQuerySchema = z.object({
  resource: z.string().min(1).default("/resource"),
  amountAtomic: z.string().regex(/^\d+$/).optional(),
  builderId: z.string().min(1).optional(),
  builderFeeBps: z.coerce.number().int().min(0).max(10_000).optional(),
  builderRecipient: z.string().min(1).optional(),
  builderStatus: z.enum(["ACTIVE", "REVIEW_REQUIRED", "SUSPENDED", "DISABLED"]).optional(),
  builderFeeMode: z.enum(["display_only", "builder_accrual", "direct_split"]).optional(),
  builderFeeHidden: z.enum(["true", "false"]).optional(),
});

const commitBodySchema = z.object({
  quoteId: z.string().uuid(),
  payerCommitment32B: z.string().min(1),
});

const paymentProofSchema = z.discriminatedUnion("settlement", [
  z.object({
    settlement: z.literal("transfer"),
    txSignature: z.string().min(32),
    amountAtomic: z.string().regex(/^\d+$/).optional(),
  }),
  z.object({
    settlement: z.literal("stream"),
    streamId: z.string().min(10),
    topupSignature: z.string().min(32).optional(),
    amountAtomic: z.string().regex(/^\d+$/).optional(),
  }),
  z.object({
    settlement: z.literal("netting"),
    amountAtomic: z.string().regex(/^\d+$/).optional(),
    note: z.string().max(256).optional(),
  }),
]);

const splitPaymentProofSchema = z.object({
  feeLineId: z.string().min(1),
  paymentProof: paymentProofSchema,
});

const finalizeBodySchema = z.object({
  commitId: z.string().uuid(),
  paymentProof: paymentProofSchema.optional(),
  splitPaymentProofs: z.array(splitPaymentProofSchema).min(1).optional(),
});

const agentWalletRegistrationSchema = z.object({
  ownerWallet: z.string().min(1),
  publicKey: z.string().min(1),
  chain: z.enum(["SOLANA", "POLYMARKET_POLYGON", "EVM", "OTHER"]),
  keyStorage: z.enum(["LOCAL_ENCRYPTED", "USER_EXPORTED", "SESSION_ONLY", "EXTERNAL_WALLET"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const paperTradeSchema = z.object({
  marketId: z.string().min(1),
  side: z.enum(["YES", "NO", "BUY", "SELL"]),
  amountAtomic: z.string().regex(/^\d+$/),
  priceBps: z.number().int().min(0).max(10_000).optional(),
  realizedPnlAtomic: z.string().regex(/^-?\d+$/).optional(),
  unrealizedPnlAtomic: z.string().regex(/^-?\d+$/).optional(),
});

const profilePatchSchema = z.object({
  visibility: z.enum(["PRIVATE", "PUBLIC"]).optional(),
  modeBadge: z.enum(["PAPER", "LIVE_VERIFIED", "MIXED", "UNVERIFIED"]).optional(),
  totalPnlAtomic: z.string().regex(/^-?\d+$/).optional(),
  roiBps: z.number().int().optional(),
  winRateBps: z.number().int().min(0).max(10_000).optional(),
  averageEntryPriceBps: z.number().int().min(0).max(10_000).optional(),
  medianEntryPriceBps: z.number().int().min(0).max(10_000).optional(),
  totalVolumeAtomic: z.string().regex(/^\d+$/).optional(),
  tradeCount: z.number().int().min(0).optional(),
  resolvedTradeCount: z.number().int().min(0).optional(),
  averageBetSizeAtomic: z.string().regex(/^\d+$/).optional(),
  maxDrawdownBps: z.number().int().min(0).max(10_000).optional(),
  copiedFollowerProfitAtomic: z.string().regex(/^\d+$/).optional(),
  copiedFollowerLossAtomic: z.string().regex(/^\d+$/).optional(),
  copiedVolumeAtomic: z.string().regex(/^\d+$/).optional(),
  followerCount: z.number().int().min(0).optional(),
  last30dPnlAtomic: z.string().regex(/^-?\d+$/).optional(),
  last30dRoiBps: z.number().int().optional(),
  badges: z.array(z.string()).optional(),
});

const alphaMonetizationSchema = z.object({
  enabled: z.boolean(),
  successFeeBps: z.number().int(),
  mode: z.enum(["DISPLAY_ONLY", "ACCRUAL", "DIRECT_SPLIT_GATED"]).optional(),
});

const copySettingsSchema = z.object({
  copySettingsId: z.string().min(1).optional(),
  followerAgentId: z.string().min(1),
  sourceAgentId: z.string().min(1),
  enabled: z.boolean().optional(),
  mode: z.enum(["WATCH_ONLY", "PAPER_COPY", "USER_CONFIRMED_COPY", "AUTO_COPY_PUBLIC_BETA"]).optional(),
  copyBuys: z.boolean().optional(),
  copySells: z.boolean().optional(),
  copyExits: z.boolean().optional(),
  minEntryPriceBps: z.number().int().min(0).max(10_000).optional(),
  maxEntryPriceBps: z.number().int().min(0).max(10_000).optional(),
  maxBetSizeAtomic: z.string().regex(/^\d+$/).optional(),
  maxDailySpendAtomic: z.string().regex(/^\d+$/).optional(),
  maxOpenExposureAtomic: z.string().regex(/^\d+$/).optional(),
  maxDailyLossAtomic: z.string().regex(/^\d+$/).optional(),
  useSourceExitRules: z.boolean().optional(),
  customTakeProfitBps: z.number().int().min(0).max(100_000).optional(),
  customStopLossBps: z.number().int().min(0).max(100_000).optional(),
  allowedMarketIds: z.array(z.string()).optional(),
  blockedMarketIds: z.array(z.string()).optional(),
  allowedCategories: z.array(z.string()).optional(),
  blockedCategories: z.array(z.string()).optional(),
  maxSlippageBps: z.number().int().min(0).max(10_000).optional(),
  maxPriceDriftBps: z.number().int().min(0).max(10_000).optional(),
  requireApprovalAboveAtomic: z.string().regex(/^\d+$/).optional(),
  requireApprovalAlways: z.boolean().optional(),
  stopCopyAfterDrawdownBps: z.number().int().min(0).max(10_000).optional(),
  expiresAt: z.string().datetime().optional(),
});

const sourceAgentActionSchema = z.object({
  sourceActionId: z.string().min(1),
  sourceAgentId: z.string().min(1),
  actionType: z.enum(["BUY", "SELL", "EXIT"]),
  marketId: z.string().min(1),
  category: z.string().optional(),
  side: z.enum(["YES", "NO", "BUY", "SELL"]),
  entryPriceBps: z.number().int().min(0).max(10_000),
  sizeAtomic: z.string().regex(/^\d+$/),
  slippageBps: z.number().int().min(0).max(10_000).optional(),
  priceDriftBps: z.number().int().min(0).max(10_000).optional(),
  sourceAgentAllowed: z.boolean().optional(),
});

const copyDecisionSchema = z.object({
  copySettingsId: z.string().min(1).optional(),
  settings: copySettingsSchema.extend({
    copySettingsId: z.string().min(1),
    enabled: z.boolean(),
    mode: z.enum(["WATCH_ONLY", "PAPER_COPY", "USER_CONFIRMED_COPY", "AUTO_COPY_PUBLIC_BETA"]),
    copyBuys: z.boolean(),
    copySells: z.boolean(),
    copyExits: z.boolean(),
    maxBetSizeAtomic: z.string().regex(/^\d+$/),
    maxDailySpendAtomic: z.string().regex(/^\d+$/),
    maxOpenExposureAtomic: z.string().regex(/^\d+$/),
    useSourceExitRules: z.boolean(),
    requireApprovalAlways: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }).optional(),
  sourceAction: sourceAgentActionSchema,
  currentDailySpendAtomic: z.string().regex(/^\d+$/).optional(),
  currentOpenExposureAtomic: z.string().regex(/^\d+$/).optional(),
  currentDailyLossAtomic: z.string().regex(/^\d+$/).optional(),
  emergencyPaused: z.boolean().optional(),
  liveCopyGateAllowed: z.boolean().optional(),
  createLot: z.boolean().optional(),
});

const copiedLotFinalizeSchema = z.object({
  realizedPnlAtomic: z.string().regex(/^-?\d+$/),
  finalized: z.boolean().optional(),
});

const agentBuilderRequestSchema = z.object({
  inputMode: z.enum(["PROMPT", "GUIDED", "TEMPLATE", "CLONE"]),
  prompt: z.string().max(4000).optional(),
  templateId: z.string().min(1).optional(),
  cloneFromAgentId: z.string().min(1).optional(),
  guidedAnswers: z.record(z.string(), z.unknown()).optional(),
  ownerWallet: z.string().min(1),
}).passthrough();

const agentBuilderConfirmSchema = z.object({
  ownerWallet: z.string().min(1),
  acceptedRiskSummary: z.boolean(),
  confirmations: z.array(z.string()).optional(),
});

const agentBuilderRejectSchema = z.object({
  ownerWallet: z.string().min(1).optional(),
});

const agentConfigDraftSchema: z.ZodType<AgentConfigDraft> = z.object({
  draftId: z.string().min(1),
  ownerWallet: z.string().min(1),
  agentType: z.enum([
    "PAPER_AGENT",
    "POLYMARKET_SIGNAL_AGENT",
    "POLYMARKET_COPY_AGENT",
    "SOLANA_TOKEN_SIGNAL_AGENT",
    "SOLANA_TOKEN_COPY_AGENT",
    "PAID_API_AGENT",
    "DATA_FEED_AGENT",
    "BUILDER_TOOL_AGENT",
    "ALPHA_PROFILE_AGENT",
  ]),
  displayName: z.string().min(1),
  slug: z.string().min(1),
  mode: z.enum(["PAPER", "SIGNAL_ONLY", "USER_CONFIRMED_LIVE", "AUTO_COPY_PUBLIC_BETA"]),
  walletMode: z.enum(["NONE_REQUIRED", "CLIENT_SIDE_USER_OWNED", "EXTERNAL_WALLET"]),
  backendCustody: z.literal(false),
  backendSigning: z.literal(false),
  marketScope: z.object({
    venue: z.enum(["POLYMARKET", "SOLANA", "DNA_X402", "OTHER"]).optional(),
    categories: z.array(z.string()).optional(),
    allowedMarketIds: z.array(z.string()).optional(),
    blockedMarketIds: z.array(z.string()).optional(),
    tokenMints: z.array(z.string()).optional(),
    marketFilters: z.array(z.string()).optional(),
  }).optional(),
  copySettings: z.object({
    copyBuys: z.boolean(),
    copySells: z.boolean(),
    copyExits: z.boolean(),
    minEntryPriceBps: z.number().int().min(0).max(10_000).optional(),
    maxEntryPriceBps: z.number().int().min(0).max(10_000).optional(),
    maxBetSizeAtomic: z.string().regex(/^\d+$/).optional(),
    maxDailySpendAtomic: z.string().regex(/^\d+$/).optional(),
    maxDailyLossAtomic: z.string().regex(/^\d+$/).optional(),
    maxOpenExposureAtomic: z.string().regex(/^\d+$/).optional(),
    customTakeProfitBps: z.number().int().min(0).max(100_000).optional(),
    customStopLossBps: z.number().int().min(0).max(100_000).optional(),
    requireApprovalAlways: z.boolean(),
    requireApprovalAboveAtomic: z.string().regex(/^\d+$/).optional(),
  }).optional(),
  monetization: z.object({
    enabled: z.boolean(),
    successFeeBps: z.union([
      z.literal(50),
      z.literal(100),
      z.literal(150),
      z.literal(200),
      z.literal(250),
      z.literal(300),
    ]).optional(),
    appliesTo: z.literal("POSITIVE_FINALIZED_COPIED_LOT_PNL"),
    mode: z.enum(["DISPLAY_ONLY", "ACCRUAL", "DIRECT_SPLIT_GATED"]),
  }).optional(),
  visibility: z.enum(["PRIVATE", "PUBLIC"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const agentRecipeCreateSchema = z.object({
  ownerWallet: z.string().min(1),
  title: z.string().min(1).max(140),
  description: z.string().min(1).max(1000),
  prompt: z.string().max(4000).optional(),
  source: z.enum(["PROMPT", "GUIDED", "TEMPLATE", "CLONE"]).optional(),
  ownerAgentId: z.string().min(1).optional(),
  visibility: z.enum(["PRIVATE", "PUBLIC", "CLONEABLE"]).optional(),
  config: agentConfigDraftSchema,
  riskSummary: z.object({
    riskLevel: z.enum(["LOW", "MEDIUM", "HIGH", "OUT_OF_SCOPE"]),
    realFundsAtRisk: z.boolean(),
    requiresClientSignature: z.boolean(),
    backendCustody: z.literal(false),
    backendSigning: z.literal(false),
    maxBetSizeAtomic: z.string().regex(/^\d+$/).optional(),
    maxDailySpendAtomic: z.string().regex(/^\d+$/).optional(),
    maxDailyLossAtomic: z.string().regex(/^\d+$/).optional(),
    maxOpenExposureAtomic: z.string().regex(/^\d+$/).optional(),
    warnings: z.array(z.string()),
    requiredConfirmations: z.array(z.string()),
  }).optional(),
});

const agentRecipeCloneSchema = z.object({
  ownerWallet: z.string().min(1),
});

const signedWebhookEnvelopeSchema = z.object({
  idempotencyKey: z.string().min(1),
  event: z.string().min(1),
  timestamp: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()),
  signature: z.string().min(64).max(256),
});

const flushSchema = z.object({
  nowMs: z.number().int().positive().optional(),
});

const DEFAULT_RESOURCE_PRICING: Record<string, bigint> = {
  "/resource": 1_000n,
  "/inference": 5_000n,
  "/stream-access": 100n,
};

const CORE_SHOP_ID = "dnp-core";
const RESOURCE_CAPABILITY_TAGS: Record<string, string[]> = {
  "/resource": ["resource_access"],
  "/inference": ["inference"],
  "/stream-access": ["stream_access"],
};

const AUDIT_FIXTURE_BASE_PATH = "/audit/primitives";
const AUDIT_FIXTURES: Array<{ id: string; path: string; title: string }> = [
  { id: "fixed_price_tool", path: `${AUDIT_FIXTURE_BASE_PATH}/fixed-price`, title: "Fixed-Price Tool" },
  { id: "usage_metered_tool", path: `${AUDIT_FIXTURE_BASE_PATH}/usage-metered`, title: "Usage-Metered Tool" },
  { id: "surge_priced_tool", path: `${AUDIT_FIXTURE_BASE_PATH}/surge-priced`, title: "Surge-Priced Tool" },
  { id: "english_auction", path: `${AUDIT_FIXTURE_BASE_PATH}/english-auction`, title: "English Auction" },
  { id: "dutch_auction", path: `${AUDIT_FIXTURE_BASE_PATH}/dutch-auction`, title: "Dutch Auction" },
  { id: "sealed_bid_commit_reveal", path: `${AUDIT_FIXTURE_BASE_PATH}/sealed-bid`, title: "Sealed Bid Commit/Reveal" },
  { id: "prediction_market_binary", path: `${AUDIT_FIXTURE_BASE_PATH}/prediction-binary`, title: "Prediction Market Binary" },
  { id: "reverse_auction", path: `${AUDIT_FIXTURE_BASE_PATH}/reverse-auction`, title: "Reverse Auction" },
  { id: "subscription_stream_gate", path: `${AUDIT_FIXTURE_BASE_PATH}/subscription-stream`, title: "Subscription Stream Gate" },
  { id: "bundle_reseller_margin", path: `${AUDIT_FIXTURE_BASE_PATH}/bundle-margin`, title: "Bundle Reseller Margin" },
];

function hashHex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function timingSafeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function realChainDrillPlatformFee(quote: Quote, config: X402Config): {
  mode: "display_only" | "seller_accrual";
  platformFeeBps: number;
  platformFeeAtomic: string;
  platformRecipient: string;
} | undefined {
  const drill = config.realChainDrill;
  if (!drill?.enabled || drill.feeMode === "none" || drill.feeMode === "direct_split" || !drill.platformRecipient) {
    return undefined;
  }

  const platformFeeAtomic = (parseAtomic(quote.amountAtomic) * BigInt(drill.platformFeeBps)) / 10_000n;
  return {
    mode: drill.feeMode,
    platformFeeBps: drill.platformFeeBps,
    platformFeeAtomic: toAtomicString(platformFeeAtomic),
    platformRecipient: drill.platformRecipient,
  };
}

function realChainDrillFeeDisclosure(quote: Quote, config: X402Config): QuoteResponse["feeWaterfall"] {
  const fee = realChainDrillPlatformFee(quote, config);
  if (!fee) {
    return undefined;
  }

  return {
    ...fee,
    collected: false,
    note: fee.mode === "display_only"
      ? "Displayed for drill only; not collected in this payment."
      : "Recorded as seller payable ledger only; not auto-collected.",
  };
}

function toQuoteResponse(quote: Quote, config: X402Config): QuoteResponse {
  return {
    quoteId: quote.quoteId,
    amount: quote.amountAtomic,
    mint: quote.mint,
    recipient: quote.recipient,
    expiresAt: quote.expiresAt,
    settlement: quote.settlement,
    memoHash: quote.memoHash,
    feeAtomic: quote.feeAtomic,
    totalAtomic: quote.totalAtomic,
    feeWaterfall: realChainDrillFeeDisclosure(quote, config),
    feeWaterfallV2: quote.feeWaterfallV2,
  };
}

function inferNetworkLabel(rpcUrl: string): "solana-devnet" | "solana-mainnet" {
  if (rpcUrl.includes("devnet")) {
    return "solana-devnet";
  }
  return "solana-mainnet";
}

function chooseRecommendedMode(quote: Quote, config: X402Config): SettlementMode {
  const total = parseAtomic(quote.totalAtomic);
  if (config.unsafeUnverifiedNettingEnabled && shouldUseNetting(config.feePolicy, total) && quote.settlement.includes("netting")) {
    return "netting";
  }
  if (quote.resource.includes("stream") && quote.settlement.includes("stream")) {
    return "stream";
  }
  return quote.settlement.includes("transfer") ? "transfer" : quote.settlement[0];
}

function buildAcceptModes(quote: Quote, config: X402Config): PaymentAccept[] {
  const network = inferNetworkLabel(config.solanaRpcUrl);
  return quote.settlement.map((mode) => ({
    scheme: "solana-spl",
    network,
    mint: quote.mint,
    maxAmount: quote.totalAtomic,
    recipient: quote.recipient,
    mode,
  }));
}

function splitPaymentRequirementsForQuote(quote: Quote, config: X402Config): SplitPaymentProofRequirement[] | undefined {
  if (!quote.feeWaterfallV2 || !config.builderMonetization?.directSplitFeesEnabled || !config.builderMonetization.directSplitGateRef) {
    return undefined;
  }
  const requirements = buildSplitPaymentRequirements(quote.feeWaterfallV2, "solana");
  return requirements.length > 0 ? requirements : undefined;
}

function buildPaymentRequirements(quote: Quote, baseUrl: string, config: X402Config): PaymentRequirements {
  const splitPaymentRequirements = splitPaymentRequirementsForQuote(quote, config);
  return {
    version: "x402-dnp-v1",
    quote: toQuoteResponse(quote, config),
    accepts: buildAcceptModes(quote, config),
    splitPaymentRequirements,
    recommendedMode: chooseRecommendedMode(quote, config),
    commitEndpoint: `${baseUrl}/commit`,
    finalizeEndpoint: `${baseUrl}/finalize`,
    receiptEndpoint: `${baseUrl}/receipt/:receiptId`,
  };
}

function isExpired(expiresAtIso: string, now: Date): boolean {
  return now.getTime() >= new Date(expiresAtIso).getTime();
}

function inferBaseUrl(req: express.Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

function endpointIdForResource(resource: string): string {
  const cleaned = resource.replace(/^\//, "").replace(/[^a-zA-Z0-9_-]+/g, "-");
  return cleaned.length > 0 ? cleaned : "resource";
}

function capabilityTagsForResource(resource: string): string[] {
  return RESOURCE_CAPABILITY_TAGS[resource] ?? [endpointIdForResource(resource)];
}

function requestBodyForDigest(req: express.Request): unknown {
  if (req.method === "GET" || req.method === "HEAD") {
    return undefined;
  }
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body) && Object.keys(req.body as Record<string, unknown>).length === 0) {
    return undefined;
  }
  return req.body;
}

function auditFixtureForResource(resource: string): { id: string; path: string; title: string } | undefined {
  return AUDIT_FIXTURES.find((fixture) => fixture.path === resource);
}

function fulfilledResponseBody(resource: string): Record<string, unknown> {
  // Bind receipts to the stable protected payload, not to dynamic metadata like the receipt itself.
  const fixture = auditFixtureForResource(resource);
  if (fixture) {
    return {
      ok: true,
      fixtureId: fixture.id,
      title: fixture.title,
      seller_defined: true,
      output: {
        primitive: fixture.id,
        mode: "audit-fixture",
      },
    };
  }
  if (resource === "/inference") {
    return { ok: true, output: "inference result" };
  }
  if (resource === "/stream-access") {
    return {
      ok: true,
      stream: {
        access: "granted",
        mode: "realtime",
      },
    };
  }
  return { ok: true, data: "resource payload" };
}

function fulfilledResponseDigest(resource: string): string {
  return computeResponseDigest({
    status: 200,
    body: fulfilledResponseBody(resource),
  });
}

function canonicalRequiredFromQuote(quote: Quote, config: X402Config): CanonicalPaymentRequired {
  return {
    version: "x402-v1",
    network: "solana",
    currency: config.defaultCurrency,
    amountAtomic: quote.totalAtomic,
    recipient: quote.recipient,
    memo: quote.memoHash,
    expiresAt: new Date(quote.expiresAt).getTime(),
    settlement: {
      mode: "spl_transfer",
      mint: quote.mint,
    },
    raw: {
      headers: {},
    },
  };
}

function proofToPaymentProof(proof: NonNullable<ReturnType<typeof normalizeX402>["proof"]>, required: CanonicalPaymentRequired): PaymentProof {
  if (proof.scheme === "solana_spl" && proof.txSig) {
    return {
      settlement: "transfer",
      txSignature: proof.txSig,
      amountAtomic: required.amountAtomic,
    };
  }
  if (proof.scheme === "unknown" && proof.txSig) {
    return {
      settlement: "transfer",
      txSignature: proof.txSig,
      amountAtomic: required.amountAtomic,
    };
  }
  return {
    settlement: "netting",
    amountAtomic: required.amountAtomic,
    note: "compat-opaque-proof",
  };
}

function verifierErrorCode(verification: { error?: string; errorCode?: string; retryable?: boolean }): X402ErrorCode {
  switch (verification.errorCode) {
    case "INVALID_PROOF":
      return X402ErrorCode.X402_PROOF_INVALID;
    case "NOT_CONFIRMED_YET":
      return X402ErrorCode.X402_NOT_CONFIRMED_YET;
    case "RPC_UNAVAILABLE":
      return X402ErrorCode.X402_RPC_UNAVAILABLE;
    case "UNDERPAY":
      return X402ErrorCode.X402_UNDERPAY;
    case "WRONG_MINT":
      return X402ErrorCode.X402_WRONG_MINT;
    case "WRONG_RECIPIENT":
      return X402ErrorCode.X402_WRONG_RECIPIENT;
    case "TOO_OLD":
      return X402ErrorCode.X402_EXPIRED_REQUIREMENTS;
    default:
      break;
  }

  const normalized = String(verification.error ?? "").toLowerCase();
  if (normalized.includes("invalid proof") || normalized.includes("invalid tx signature")) {
    return X402ErrorCode.X402_PROOF_INVALID;
  }
  if (normalized.includes("not confirmed")) {
    return X402ErrorCode.X402_NOT_CONFIRMED_YET;
  }
  if (normalized.includes("rpc unavailable") || normalized.includes("too many requests")) {
    return X402ErrorCode.X402_RPC_UNAVAILABLE;
  }
  if (normalized.includes("underpaid") || normalized.includes("underpay")) {
    return X402ErrorCode.X402_UNDERPAY;
  }
  if (normalized.includes("wrong mint")) {
    return X402ErrorCode.X402_WRONG_MINT;
  }
  if (normalized.includes("wrong recipient")) {
    return X402ErrorCode.X402_WRONG_RECIPIENT;
  }
  return X402ErrorCode.X402_VERIFICATION_FAILED;
}

  function isDevnetCluster(config: X402Config): boolean {
  const cluster = (config.cluster ?? "").toLowerCase();
  if (cluster === "devnet") {
    return true;
  }
  return config.solanaRpcUrl.includes("devnet");
}

function createFixedWindowRateLimiter(maxRequests: number, windowMs: number) {
  const windows = new Map<string, { count: number; resetAtMs: number }>();
  return (key: string, nowMs: number): boolean => {
    const current = windows.get(key);
    if (!current || nowMs >= current.resetAtMs) {
      windows.set(key, { count: 1, resetAtMs: nowMs + windowMs });
      return true;
    }
    if (current.count >= maxRequests) {
      return false;
    }
    current.count += 1;
    windows.set(key, current);
    return true;
  };
}

function createGlobalProofReplayKey(input: { shopId: string; proofId: string; settlement: "transfer" | "stream" }): string {
  return createReplayKey({
    shopId: input.shopId,
    txSig: `${input.settlement}:${input.proofId}`,
    amountAtomic: "*",
    recipient: "*",
    mint: "*",
  });
}

function resolveGuardConfig(config: X402Config): X402GuardConfig {
  return config.dnaGuard ?? {
    enabled: false,
    failMode: "fail-open",
    windowMs: 86_400_000,
    spendCeilings: {},
  };
}

function guardActorFromRequest(req: express.Request): {
  buyerId?: string;
  walletAddress?: string;
  agentId?: string;
  apiKeyId?: string;
} {
  return {
    buyerId: req.header("x-dna-buyer-id") ?? undefined,
    walletAddress: req.header("x-dna-wallet") ?? undefined,
    agentId: req.header("x-dna-agent-id") ?? undefined,
    apiKeyId: req.header("x-dna-api-key-id") ?? undefined,
  };
}

function hasGuardSpendCeilings(config: X402GuardConfig): boolean {
  return Boolean(
    config.spendCeilings.buyerAtomic
    || config.spendCeilings.walletAtomic
    || config.spendCeilings.agentAtomic
    || config.spendCeilings.apiKeyAtomic,
  );
}

function isDuplicatePersistenceError(error: unknown): boolean {
  const maybeCode = (error as { code?: string }).code;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return maybeCode === "23505" || message.includes("duplicate") || message.includes("unique");
}

function createWebhookReplayClaimStore(config: X402Config): WebhookReplayClaimStore {
  const memoryReplay = new Set<string>();
  const databaseUrl = config.databaseUrl;
  const usePostgres = (config.repositoryMode ?? "").toLowerCase() === "postgres" && Boolean(databaseUrl);
  if (!usePostgres || !databaseUrl) {
    return {
      async claim(input) {
        if (memoryReplay.has(input.idempotencyKey)) {
          return false;
        }
        memoryReplay.add(input.idempotencyKey);
        return true;
      },
    };
  }

  const db = new PostgresDbClient({ connectionString: databaseUrl });
  const repositories = createPostgresCommerceRepositories(db);
  return {
    async claim(input) {
      try {
        await repositories.webhook_replay_keys.append(input.idempotencyKey, {
          idempotencyKey: input.idempotencyKey,
          event: input.event,
          timestamp: input.timestamp,
          claimedAt: new Date().toISOString(),
        }, { actorId: "webhook-receiver" });
        return true;
      } catch (error) {
        if (isDuplicatePersistenceError(error)) {
          return false;
        }
        throw error;
      }
    },
  };
}

function createFeeLedgerStore(config: X402Config): FeeLedgerStore {
  const databaseUrl = config.databaseUrl;
  const usePostgres = (config.repositoryMode ?? "").toLowerCase() === "postgres" && Boolean(databaseUrl);
  if (!usePostgres || !databaseUrl) {
    return {
      async recordWaterfall() {},
      async recordAccrual() {},
    };
  }

  const db = new PostgresDbClient({ connectionString: databaseUrl });
  const repositories = createPostgresCommerceRepositories(db);
  async function appendImmutable(table: "fee_waterfalls" | "fee_accruals", id: string, payload: unknown): Promise<void> {
    try {
      await repositories[table].append(id, payload, { actorId: "fee-ledger" });
    } catch (error) {
      if (isDuplicatePersistenceError(error)) {
        return;
      }
      throw error;
    }
  }

  return {
    async recordWaterfall(waterfall) {
      await appendImmutable("fee_waterfalls", waterfall.feeWaterfallHash, waterfall);
    },
    async recordAccrual(accrual) {
      await appendImmutable("fee_accruals", accrual.id, accrual);
    },
  };
}

function createAgentTradingRepositories(config: X402Config): AgentTradingRepositories | undefined {
  const databaseUrl = config.databaseUrl;
  const usePostgres = (config.repositoryMode ?? "").toLowerCase() === "postgres" && Boolean(databaseUrl);
  if (!usePostgres || !databaseUrl) {
    return undefined;
  }

  const db = new PostgresDbClient({ connectionString: databaseUrl });
  const repositories = createPostgresCommerceRepositories(db);
  return {
    agentWallets: repositories.agent_wallets as AgentTradingRepositories["agentWallets"],
    paperAgentAccounts: repositories.paper_agent_accounts as AgentTradingRepositories["paperAgentAccounts"],
    agentProfiles: repositories.agent_profiles as AgentTradingRepositories["agentProfiles"],
    alphaMonetizationConfigs: repositories.alpha_monetization_configs as AgentTradingRepositories["alphaMonetizationConfigs"],
    copySettings: repositories.copy_settings as AgentTradingRepositories["copySettings"],
    copyDecisions: repositories.copy_decisions as AgentTradingRepositories["copyDecisions"],
    copiedLots: repositories.copied_lots as AgentTradingRepositories["copiedLots"],
    alphaFeeAccruals: repositories.alpha_fee_accruals as AgentTradingRepositories["alphaFeeAccruals"],
    agentActionLedgers: repositories.agent_action_ledgers as AgentTradingRepositories["agentActionLedgers"],
  };
}

function createAgentBuilderRepositories(config: X402Config): AgentBuilderRepositories | undefined {
  const databaseUrl = config.databaseUrl;
  const usePostgres = (config.repositoryMode ?? "").toLowerCase() === "postgres" && Boolean(databaseUrl);
  if (!usePostgres || !databaseUrl) {
    return undefined;
  }

  const db = new PostgresDbClient({ connectionString: databaseUrl });
  const repositories = createPostgresCommerceRepositories(db);
  return {
    drafts: repositories.agent_builder_drafts as AgentBuilderRepositories["drafts"],
    recipes: repositories.agent_recipes as AgentBuilderRepositories["recipes"],
    events: repositories.agent_builder_events as AgentBuilderRepositories["events"],
  };
}

export function createX402App(config: X402Config = loadConfig(), deps: CreateAppDeps = {}): {
  app: express.Express;
  context: X402AppContext;
} {
  assertRuntimeGateConfig(config);
  const runtimeGates = runtimeGatesForConfig(config);
  const app = express();
  const now = deps.now ?? (() => new Date());
  const guardConfig = resolveGuardConfig(config);
  const feeLedgerStore = deps.feeLedgerStore ?? createFeeLedgerStore(config);

  const connection = new Connection(config.solanaRpcUrl, "confirmed");
  const paymentVerifier = deps.paymentVerifier ?? new SolanaPaymentVerifier(connection, {
    allowUnverifiedNetting: config.unsafeUnverifiedNettingEnabled,
    allowedSignerWallets: config.realChainDrill?.enabled ? config.realChainDrill.allowedSigners : undefined,
  });
  const receiptSigner = deps.receiptSigner ?? (config.receiptSigningSecret
    ? ReceiptSigner.fromBase58Secret(config.receiptSigningSecret)
    : ReceiptSigner.generate());
  const nettingLedger = deps.nettingLedger ?? new NettingLedger({
    settleThresholdAtomic: config.nettingThresholdAtomic,
    settleIntervalMs: config.nettingIntervalMs,
    feeAccrualThresholdAtomic: config.feePolicy.accrueThresholdAtomic,
  });
  const replayStore = deps.replayStore ?? new ReplayStore();
  const auditLog = deps.auditLog ?? new AuditLogger({
    filePath: config.auditLogPath,
  });
  const webhookService = deps.webhookService ?? new WebhookService({
    signingSecret: config.webhookSigningSecret,
    onDelivery: (result) => {
      auditLog.record({
        kind: result.ok ? "WEBHOOK_SENT" : "WEBHOOK_FAILED",
        durationMs: result.durationMs,
        meta: { url: result.url, status: result.status, retryCount: result.retryCount, error: result.error },
      });
    },
  });
  const webhookReplayClaimStore = deps.webhookReplayClaimStore ?? createWebhookReplayClaimStore(config);
  const guard = deps.guard ?? (guardConfig.enabled
    ? createDnaGuard({
      auditLog,
      ledger: createFileBackedDnaGuardLedger({
        snapshotPath: guardConfig.snapshotPath,
        windowMs: guardConfig.windowMs,
        now,
      }),
    })
    : undefined);
  const emergencyPause = deps.emergencyPause ?? new EmergencyPauseController(undefined, undefined, now);
  const governance = deps.governance ?? new GovernanceService(now);
  const agentTrading = deps.agentTrading ?? new AgentTradingService(now, createAgentTradingRepositories(config));
  const agentBuilder = deps.agentBuilder ?? new AgentBuilderService(now, createAgentBuilderRepositories(config));
  const { router: marketRouter, context: market } = createMarketRouter({
    now,
    signer: receiptSigner,
    pauseMarket: config.pauseMarket || emergencyPause.isPaused("marketplacePaused"),
    pauseOrders: config.pauseOrders,
    disabledShops: config.disabledShops,
    autoDisableReportThreshold: config.autoDisableReportThreshold,
  });

  const quotes = new Map<string, Quote>();
  const commits = new Map<string, CommitRecord>();
  const receipts = new Map<string, SignedReceipt>();
  const realChainFeeAccruals: RealChainFeeAccrualRecord[] = [];
  const feeAccruals: FeeAccrualRecord[] = [];
  const observedAgentIds = new Set<string>();
  const realChainDrillUsage = { dayKey: "", finalizedAtomic: 0n };
  const publicBetaLiveUsage = { dayKey: "", finalizedAtomic: 0n };

  const context: X402AppContext = {
    quotes,
    commits,
    receipts,
    receiptSigner,
    nettingLedger,
    market,
    anchoringQueue: undefined,
    replayStore,
    config,
    auditLog,
    webhookService,
    webhookReplayClaimStore,
    realChainFeeAccruals,
    feeAccruals,
    observedAgentIds,
    agentTrading,
    agentBuilder,
    guard,
    emergencyPause,
    governance,
  };
  const auditFixturesEnabled = Boolean(config.auditFixtures) && isDevnetCluster(config);
  if (config.gauntletMode && !isDevnetCluster(config)) {
    throw new Error("GAUNTLET_MODE is allowed only on devnet cluster.");
  }
  if (config.gauntletMode && auditFixturesEnabled) {
    throw new Error("GAUNTLET_MODE requires AUDIT_FIXTURES=0.");
  }

  function recordMarketEvent(event: Parameters<MarketContext["recordEvent"]>[0]): void {
    try {
      market.recordEvent(event);
    } catch {
      // Ignore analytics failures to keep payment path hot.
    }
  }

  function recordGuardAudit(
    kind:
    | "GUARD_SPEND_BLOCKED"
    | "GUARD_REPLAY_ALERT"
    | "GUARD_VALIDATION_FAILED"
    | "GUARD_DISPUTE_TAGGED"
    | "GUARD_RECEIPT_VERIFIED"
    | "GUARD_RECEIPT_INVALID"
    | "GUARD_FAIL_OPEN"
    | "GUARD_RUNTIME_ERROR",
    input: {
      req?: express.Request;
      endpointId?: string;
      receiptId?: string;
      amountAtomic?: string;
      reason?: string;
      meta?: Record<string, unknown>;
    },
  ): void {
    const actor = input.req ? observeGuardActor(input.req) : undefined;
    auditLog.record({
      kind,
      traceId: input.req?.traceId,
      actor: actor?.buyerId ?? actor?.agentId ?? actor?.walletAddress ?? actor?.apiKeyId,
      shopId: CORE_SHOP_ID,
      endpointId: input.endpointId,
      receiptId: input.receiptId,
      amountAtomic: input.amountAtomic,
      errorMessage: input.reason,
      meta: input.meta,
    });
  }

  function observeGuardActor(req: express.Request): ReturnType<typeof guardActorFromRequest> {
    const actor = guardActorFromRequest(req);
    if (actor.agentId) {
      observedAgentIds.add(actor.agentId);
    }
    return actor;
  }

  function enforceGuardSpend(
    req: express.Request,
    res: express.Response,
    input: {
      resource: string;
      amountAtomic: string;
      stage: "quote" | "finalize" | "compat";
    },
  ): boolean {
    if (!guard || !hasGuardSpendCeilings(guardConfig)) {
      return true;
    }

    const endpointId = endpointIdForResource(input.resource);
    try {
      const decision = guard.ledger.checkSpend(
        observeGuardActor(req),
        input.amountAtomic,
        guardConfig.spendCeilings,
        now(),
      );
      if (decision.ok) {
        return true;
      }
      guard.ledger.recordSpendBlocked(CORE_SHOP_ID, endpointId);
      recordGuardAudit("GUARD_SPEND_BLOCKED", {
        req,
        endpointId,
        amountAtomic: input.amountAtomic,
        reason: "spend_ceiling_exceeded",
        meta: {
          enforced: guardConfig.failMode === "fail-closed",
          stage: input.stage,
          blocked: decision.blocked,
        },
      });
      if (guardConfig.failMode === "fail-closed") {
        res.status(429).json({
          error: "dna_guard_spend_blocked",
          blocked: decision.blocked,
        });
        return false;
      }
      return true;
    } catch (error) {
      recordGuardAudit(guardConfig.failMode === "fail-open" ? "GUARD_FAIL_OPEN" : "GUARD_RUNTIME_ERROR", {
        req,
        endpointId,
        amountAtomic: input.amountAtomic,
        reason: error instanceof Error ? error.message : "guard_runtime_error",
        meta: { stage: input.stage },
      });
      if (guardConfig.failMode === "fail-closed") {
        res.status(500).json({ error: "dna_guard_runtime_error" });
        return false;
      }
      return true;
    }
  }

  function recordGuardReplay(_req: express.Request, resource: string, reason: string): void {
    if (!guard) {
      return;
    }
    const endpointId = endpointIdForResource(resource);
    guard.recordReplayAlert({
      providerId: CORE_SHOP_ID,
      endpointId,
      reason,
    });
  }

  function recordGuardReceiptVerification(
    _req: express.Request | undefined,
    resource: string,
    receiptId: string,
    valid: boolean,
    reason?: string,
  ): void {
    if (!guard) {
      return;
    }
    const endpointId = endpointIdForResource(resource);
    guard.verifyReceipt({
      providerId: CORE_SHOP_ID,
      endpointId,
      receiptId,
      valid,
      reason,
      now: now(),
    });
  }

  function recordGuardDelivery(
    resource: string,
    latencyMs: number,
    statusCode: number,
    receiptId?: string,
    qualityAccepted?: boolean,
  ): void {
    if (!guard) {
      return;
    }
    const endpointId = endpointIdForResource(resource);
    guard.ledger.recordDelivery({
      providerId: CORE_SHOP_ID,
      endpointId,
      latencyMs,
      statusCode,
      receiptId,
      qualityAccepted,
    });
    if (receiptId && qualityAccepted === false) {
      recordGuardAudit("GUARD_VALIDATION_FAILED", {
        endpointId,
        receiptId,
        reason: "non_conforming_core_response",
      });
      guard.tagDispute({
        providerId: CORE_SHOP_ID,
        endpointId,
        receiptId,
        reason: "non_conforming_core_response",
      });
    }
    if (receiptId && statusCode >= 500) {
      guard.tagDispute({
        providerId: CORE_SHOP_ID,
        endpointId,
        receiptId,
        reason: `delivery_failed_${statusCode}`,
      });
    }
  }

  const shouldEnableAnchoring = config.anchoringEnabled
    && Boolean(config.receiptAnchorProgramId)
    && Boolean(config.anchoringKeypairPath);
  const protocolProgramId = config.pdxDarkProtocolProgramId ?? config.paymentProgramId ?? null;
  const anchorProgramId = config.receiptAnchorProgramId ?? null;
  const anchorProgramOk = !(protocolProgramId && anchorProgramId && protocolProgramId === anchorProgramId);

  if (shouldEnableAnchoring) {
    try {
      const anchorClient = ReceiptAnchorClient.fromEnv({
        rpcUrl: config.solanaRpcUrl,
        payerKeypairPath: config.anchoringKeypairPath as string,
        programId: config.receiptAnchorProgramId as string,
        protocolProgramId: protocolProgramId ?? undefined,
        altAddress: config.anchoringAltAddress,
        commitment: "confirmed",
      });
      anchorClient.assertProgramConfiguration();

      const anchoringQueue = deps.anchoringQueue ?? new AnchoringQueue({
        client: anchorClient,
        batchSize: config.anchoringBatchSize ?? 32,
        flushIntervalMs: config.anchoringFlushIntervalMs ?? 10_000,
        immediate: config.anchoringImmediate ?? false,
        listEvents: () => market.storage.all(),
        recordEvent: recordMarketEvent,
        signatureLogPath: config.anchoringSignatureLogPath,
      });
      anchoringQueue.start();
      context.anchoringQueue = anchoringQueue;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`anchoring_disabled: ${(error as Error).message}`);
    }
  }

  function getAmountForResource(resource: string, explicitAtomic?: string): bigint {
    if (explicitAtomic) {
      return parseAtomic(explicitAtomic);
    }
    return DEFAULT_RESOURCE_PRICING[resource] ?? DEFAULT_RESOURCE_PRICING["/resource"];
  }

  function usesCanonicalDirectSplitFees(): boolean {
    return Boolean(
      config.builderMonetization?.directSplitFeesEnabled
      && config.builderMonetization.directSplitGateRef
      && config.builderMonetization.platformFeeMode === "direct_split",
    );
  }

  function calculateLegacyFeeForQuote(amountAtomic: bigint): bigint {
    return usesCanonicalDirectSplitFees() ? 0n : calculateFeeAtomic(config.feePolicy, amountAtomic);
  }

  function getTotalAtomicForResource(resource: string, explicitAtomic?: string): string {
    const amountAtomic = getAmountForResource(resource, explicitAtomic);
    return toAtomicString(amountAtomic + calculateLegacyFeeForQuote(amountAtomic));
  }

  function realChainDrillAmountAllowed(amountAtomic: string): { ok: true } | { ok: false; reason: string } {
    const drill = config.realChainDrill;
    if (!drill?.enabled) {
      return { ok: true };
    }
    if (drill.maxTxAtomic && parseAtomic(amountAtomic) > parseAtomic(drill.maxTxAtomic)) {
      return { ok: false, reason: "real-chain drill max transaction cap exceeded" };
    }
    if (drill.dailyCapAtomic && parseAtomic(amountAtomic) > parseAtomic(drill.dailyCapAtomic)) {
      return { ok: false, reason: "real-chain drill daily cap exceeded" };
    }
    return { ok: true };
  }

  function publicBetaUsdToAtomic(valueUsd: number): bigint {
    return BigInt(Math.floor(valueUsd * 1_000_000));
  }

  function publicBetaLiveAmountAllowed(amountAtomic: string): { ok: true } | { ok: false; reason: string } {
    const beta = config.publicBeta;
    if (!beta?.enabled || !beta.liveLowRisk) {
      return { ok: true };
    }
    if (parseAtomic(amountAtomic) > publicBetaUsdToAtomic(beta.maxTxUsd)) {
      return { ok: false, reason: "Public Beta max transaction cap exceeded" };
    }
    return { ok: true };
  }

  function publicBetaLiveFinalizeAllowed(amountAtomic: string): { ok: true } | { ok: false; reason: string } {
    const beta = config.publicBeta;
    if (!beta?.enabled || !beta.liveLowRisk) {
      return { ok: true };
    }
    const dayKey = now().toISOString().slice(0, 10);
    if (publicBetaLiveUsage.dayKey !== dayKey) {
      publicBetaLiveUsage.dayKey = dayKey;
      publicBetaLiveUsage.finalizedAtomic = 0n;
    }
    const nextTotal = publicBetaLiveUsage.finalizedAtomic + parseAtomic(amountAtomic);
    if (nextTotal > publicBetaUsdToAtomic(beta.maxDailySpendUsd)) {
      return { ok: false, reason: "Public Beta cumulative daily spend cap exceeded" };
    }
    return { ok: true };
  }

  function recordPublicBetaLiveFinalize(amountAtomic: string): void {
    const beta = config.publicBeta;
    if (!beta?.enabled || !beta.liveLowRisk) {
      return;
    }
    const dayKey = now().toISOString().slice(0, 10);
    if (publicBetaLiveUsage.dayKey !== dayKey) {
      publicBetaLiveUsage.dayKey = dayKey;
      publicBetaLiveUsage.finalizedAtomic = 0n;
    }
    publicBetaLiveUsage.finalizedAtomic += parseAtomic(amountAtomic);
  }

  function realChainDrillFinalizeAllowed(amountAtomic: string): { ok: true } | { ok: false; reason: string } {
    const drill = config.realChainDrill;
    if (!drill?.enabled || !drill.dailyCapAtomic) {
      return { ok: true };
    }
    const dayKey = now().toISOString().slice(0, 10);
    if (realChainDrillUsage.dayKey !== dayKey) {
      realChainDrillUsage.dayKey = dayKey;
      realChainDrillUsage.finalizedAtomic = 0n;
    }
    const nextTotal = realChainDrillUsage.finalizedAtomic + parseAtomic(amountAtomic);
    if (nextTotal > parseAtomic(drill.dailyCapAtomic)) {
      return { ok: false, reason: "real-chain drill cumulative daily cap exceeded" };
    }
    return { ok: true };
  }

  function recordRealChainDrillFinalize(amountAtomic: string): void {
    if (!config.realChainDrill?.enabled) {
      return;
    }
    const dayKey = now().toISOString().slice(0, 10);
    if (realChainDrillUsage.dayKey !== dayKey) {
      realChainDrillUsage.dayKey = dayKey;
      realChainDrillUsage.finalizedAtomic = 0n;
    }
    realChainDrillUsage.finalizedAtomic += parseAtomic(amountAtomic);
  }

  function realChainFeeAccrualSummary(): {
    enabled: boolean;
    mode: string;
    collected: false;
    count: number;
    totalPlatformFeeAtomic: string;
    byRecipient: Array<{ recipient: string; totalPlatformFeeAtomic: string; count: number }>;
  } {
    const byRecipient = new Map<string, { total: bigint; count: number }>();
    let total = 0n;
    for (const item of realChainFeeAccruals) {
      const amount = parseAtomic(item.platformFeeAtomic);
      total += amount;
      const current = byRecipient.get(item.platformRecipient) ?? { total: 0n, count: 0 };
      current.total += amount;
      current.count += 1;
      byRecipient.set(item.platformRecipient, current);
    }

    return {
      enabled: Boolean(config.realChainDrill?.enabled),
      mode: config.realChainDrill?.feeMode ?? "none",
      collected: false,
      count: realChainFeeAccruals.length,
      totalPlatformFeeAtomic: toAtomicString(total),
      byRecipient: Array.from(byRecipient.entries()).map(([recipient, entry]) => ({
        recipient,
        totalPlatformFeeAtomic: toAtomicString(entry.total),
        count: entry.count,
      })),
    };
  }

  function recordRealChainFeeAccrual(params: {
    quote: Quote;
    commit: CommitRecord;
    receipt: SignedReceipt;
    paymentProof: PaymentProof;
    verification: { txSignature?: string };
  }): RealChainFeeAccrualRecord | undefined {
    if (config.realChainDrill?.feeMode !== "seller_accrual") {
      return undefined;
    }
    const fee = realChainDrillPlatformFee(params.quote, config);
    if (!fee || fee.mode !== "seller_accrual") {
      return undefined;
    }
    const record: RealChainFeeAccrualRecord = {
      id: crypto.randomUUID(),
      quoteId: params.quote.quoteId,
      commitId: params.commit.commitId,
      receiptId: params.receipt.payload.receiptId,
      resource: params.quote.resource,
      payerCommitment32B: params.commit.payerCommitment32B,
      amountAtomic: params.quote.amountAtomic,
      platformFeeBps: fee.platformFeeBps,
      platformFeeAtomic: fee.platformFeeAtomic,
      platformRecipient: fee.platformRecipient,
      settlement: params.paymentProof.settlement,
      txSignature: params.verification.txSignature,
      createdAt: now().toISOString(),
      collected: false,
      status: "ACCRUED_NOT_COLLECTED",
      note: "Non-custodial drill accrual only. No auto-sweep, backend custody, or hidden fee collection.",
    };
    assertImmutableRecordSafe("PROOF_RECORD", record);
    realChainFeeAccruals.push(record);
    return record;
  }

  async function verifyPaymentForQuote(quote: Quote, paymentProof: PaymentProof): Promise<{
    ok: boolean;
    settledOnchain: boolean;
    txSignature?: string;
    streamId?: string;
    error?: string;
    errorCode?: "INVALID_PROOF" | "NOT_CONFIRMED_YET" | "RPC_UNAVAILABLE" | "PAYMENT_INVALID" | "UNDERPAY" | "WRONG_MINT" | "WRONG_RECIPIENT" | "TOO_OLD";
    retryable?: boolean;
  }> {
    if (auditFixturesEnabled && quote.resource.startsWith(AUDIT_FIXTURE_BASE_PATH)) {
      if (paymentProof.settlement === "transfer") {
        if (!paymentProof.txSignature || !paymentProof.txSignature.startsWith("tx-")) {
          return { ok: false, settledOnchain: false, error: "invalid transfer proof" };
        }
        return { ok: true, settledOnchain: true, txSignature: paymentProof.txSignature };
      }
      if (paymentProof.settlement === "stream") {
        if (!paymentProof.streamId || !paymentProof.streamId.startsWith("stream-")) {
          return { ok: false, settledOnchain: false, error: "invalid stream proof" };
        }
        return { ok: true, settledOnchain: true, streamId: paymentProof.streamId };
      }
      return { ok: true, settledOnchain: false };
    }
    try {
      return await paymentVerifier.verify(quote, paymentProof);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const normalized = message.toLowerCase();
      const invalidProof = normalized.includes("invalid param: invalid") || normalized.includes("invalid signature");
      return {
        ok: false,
        settledOnchain: false,
        error: invalidProof ? "invalid payment proof" : `rpc unavailable: ${message}`,
        errorCode: invalidProof ? "INVALID_PROOF" : "RPC_UNAVAILABLE",
        retryable: !invalidProof,
      };
    }
  }

  function directSplitX402Code(message: string): X402ErrorCode {
    const normalized = message.toLowerCase();
    if (normalized.includes("replay") || normalized.includes("reused")) {
      return X402ErrorCode.X402_REPLAY_DETECTED;
    }
    if (normalized.includes("underpay")) {
      return X402ErrorCode.X402_UNDERPAY;
    }
    if (normalized.includes("wrong token") || normalized.includes("wrong mint")) {
      return X402ErrorCode.X402_WRONG_MINT;
    }
    if (normalized.includes("wrong recipient")) {
      return X402ErrorCode.X402_WRONG_RECIPIENT;
    }
    if (normalized.includes("different quote") || normalized.includes("tamper")) {
      return X402ErrorCode.X402_REQUIRED_PROOF_MISMATCH;
    }
    return X402ErrorCode.X402_PROOF_INVALID;
  }

  function quoteForSplitRequirement(quote: Quote, requirement: SplitPaymentProofRequirement): Quote {
    return {
      quoteId: quote.quoteId,
      resource: quote.resource,
      amountAtomic: requirement.amount,
      feeAtomic: "0",
      totalAtomic: requirement.amount,
      mint: quote.mint,
      recipient: requirement.recipient,
      expiresAt: quote.expiresAt,
      settlement: ["transfer"],
      memoHash: hashHex(`${quote.memoHash}:${requirement.feeLineId}:${requirement.recipient}:${requirement.amount}`),
    };
  }

  async function verifyDirectSplitProofs(
    req: express.Request,
    res: express.Response,
    commit: CommitRecord,
    quote: Quote,
    splitPaymentProofs: Array<{ feeLineId: string; paymentProof: PaymentProof }>,
  ): Promise<{
    ok: true;
    primaryPaymentProof: PaymentProof;
    primaryVerification: { settledOnchain: boolean; txSignature?: string; streamId?: string };
    receiptProofs: ReceiptPayload["splitPaymentProofs"];
  } | { ok: false }> {
    const waterfall = quote.feeWaterfallV2;
    const builderConfig = config.builderMonetization;
    const requirements = splitPaymentRequirementsForQuote(quote, config) ?? [];
    if (!waterfall || !builderConfig?.directSplitFeesEnabled || !builderConfig.directSplitGateRef || requirements.length === 0) {
      sendX402Error(req, res, new X402Error(X402ErrorCode.X402_PROOF_INVALID, {
        cause: "direct split fee gate disabled",
      }), {
        dialectDetected: "generic",
      });
      return { ok: false };
    }

    const byFeeLine = new Map<string, PaymentProof>();
    for (const item of splitPaymentProofs) {
      if (byFeeLine.has(item.feeLineId)) {
        sendX402Error(req, res, new X402Error(X402ErrorCode.X402_REPLAY_DETECTED, {
          cause: "proof reused across fee lines",
        }), {
          dialectDetected: "generic",
        });
        return { ok: false };
      }
      byFeeLine.set(item.feeLineId, item.paymentProof);
    }

    const proofResults: Array<{
      feeLineId: string;
      chain: string;
      token: string;
      recipient: string;
      amount: string;
      replayed?: boolean;
      quoteId?: string;
    }> = [];
    const receiptProofs: NonNullable<ReceiptPayload["splitPaymentProofs"]> = [];
    const replayKeys: Array<{ global: string; scoped: string; proofId: string }> = [];
    const seenProofIds = new Set<string>();
    let primaryPaymentProof: PaymentProof | undefined;
    let primaryVerification: { settledOnchain: boolean; txSignature?: string; streamId?: string } | undefined;

    for (const requirement of requirements) {
      const paymentProof = byFeeLine.get(requirement.feeLineId);
      if (!paymentProof) {
        sendX402Error(req, res, new X402Error(X402ErrorCode.X402_MISSING_PAYMENT_PROOF, {
          cause: `missing ${requirement.kind} proof`,
          details: { feeLineId: requirement.feeLineId, kind: requirement.kind },
        }), {
          dialectDetected: "generic",
        });
        return { ok: false };
      }
      if (paymentProof.settlement !== "transfer") {
        sendX402Error(req, res, new X402Error(X402ErrorCode.X402_PROOF_INVALID, {
          cause: "direct split currently requires transfer proofs for each fee line",
          details: { feeLineId: requirement.feeLineId, settlement: paymentProof.settlement },
        }), {
          dialectDetected: "generic",
        });
        return { ok: false };
      }

      const lineQuote = quoteForSplitRequirement(quote, requirement);
      const verification = await verifyPaymentForQuote(lineQuote, paymentProof);
      if (!verification.ok) {
        commit.status = "failed";
        commits.set(commit.commitId, commit);
        sendX402Error(req, res, new X402Error(verifierErrorCode(verification), {
          cause: verification.error ?? `${requirement.kind} proof rejected`,
          details: { feeLineId: requirement.feeLineId, kind: requirement.kind },
        }), {
          dialectDetected: "generic",
        });
        return { ok: false };
      }
      if (!verification.txSignature) {
        commit.status = "failed";
        commits.set(commit.commitId, commit);
        sendX402Error(req, res, new X402Error(X402ErrorCode.X402_PROOF_INVALID, {
          cause: "verified direct split transfer is missing canonical txSignature",
          details: { feeLineId: requirement.feeLineId, kind: requirement.kind },
        }), {
          dialectDetected: "generic",
        });
        return { ok: false };
      }
      if (seenProofIds.has(verification.txSignature)) {
        sendX402Error(req, res, new X402Error(X402ErrorCode.X402_REPLAY_DETECTED, {
          cause: "proof reused across fee lines",
          details: { feeLineId: requirement.feeLineId, kind: requirement.kind },
        }), {
          dialectDetected: "generic",
        });
        return { ok: false };
      }
      seenProofIds.add(verification.txSignature);

      const globalReplayKey = createGlobalProofReplayKey({
        shopId: CORE_SHOP_ID,
        proofId: verification.txSignature,
        settlement: "transfer",
      });
      const scopedReplayKey = createReplayKey({
        shopId: CORE_SHOP_ID,
        txSig: verification.txSignature,
        amountAtomic: requirement.amount,
        recipient: requirement.recipient,
        mint: quote.mint,
      });
      replayKeys.push({ global: globalReplayKey, scoped: scopedReplayKey, proofId: verification.txSignature });
      proofResults.push({
        feeLineId: requirement.feeLineId,
        chain: requirement.chain,
        token: requirement.token,
        recipient: requirement.recipient,
        amount: paymentProof.amountAtomic ?? requirement.amount,
        quoteId: quote.quoteId,
      });
      receiptProofs.push({
        feeLineId: requirement.feeLineId,
        kind: requirement.kind,
        recipient: requirement.recipient,
        amount: requirement.amount,
        token: requirement.token,
        settlement: paymentProof.settlement,
        txSignature: verification.txSignature,
      });
      if (requirement.kind === "PROVIDER_AMOUNT" || !primaryPaymentProof) {
        primaryPaymentProof = paymentProof;
        primaryVerification = {
          settledOnchain: verification.settledOnchain,
          txSignature: verification.txSignature,
        };
      }
    }

    for (const replay of replayKeys) {
      if (replayStore.has(replay.global, now().getTime()) || replayStore.has(replay.scoped, now().getTime())) {
        recordGuardReplay(req, quote.resource, "x402_direct_split_replay_detected");
        sendX402Error(req, res, new X402Error(X402ErrorCode.X402_REPLAY_DETECTED, {
          details: { settlement: "transfer", proofId: replay.proofId },
        }), {
          dialectDetected: "generic",
        });
        return { ok: false };
      }
    }

    try {
      validateSplitFinalizeRequest({
        waterfall,
        request: {
          quoteId: quote.quoteId,
          commitId: commit.commitId,
          proofs: splitPaymentProofs.map((item) => ({ feeLineId: item.feeLineId, proof: item.paymentProof })),
        },
        chain: "solana",
        directSplitEnabled: builderConfig.directSplitFeesEnabled,
        gateRef: builderConfig.directSplitGateRef,
        proofResults,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "direct split proof validation failed";
      sendX402Error(req, res, new X402Error(directSplitX402Code(message), {
        cause: message,
      }), {
        dialectDetected: "generic",
      });
      return { ok: false };
    }

    for (const replay of replayKeys) {
      if (!replayStore.consume(replay.global, now().getTime()) || !replayStore.consume(replay.scoped, now().getTime())) {
        recordGuardReplay(req, quote.resource, "x402_direct_split_replay_detected");
        sendX402Error(req, res, new X402Error(X402ErrorCode.X402_REPLAY_DETECTED, {
          details: { settlement: "transfer", proofId: replay.proofId },
        }), {
          dialectDetected: "generic",
        });
        return { ok: false };
      }
    }

    if (!primaryPaymentProof || !primaryVerification) {
      sendX402Error(req, res, new X402Error(X402ErrorCode.X402_PROOF_INVALID, {
        cause: "direct split produced no primary provider proof",
      }), {
        dialectDetected: "generic",
      });
      return { ok: false };
    }

    return {
      ok: true,
      primaryPaymentProof,
      primaryVerification,
      receiptProofs,
    };
  }

  function builderFeeFromQuery(input: z.infer<typeof quoteQuerySchema>): {
    builderProfile?: BuilderProfile;
    builderFee?: BuilderFeeConfig;
  } {
    if (!input.builderId && input.builderFeeBps === undefined && !input.builderRecipient) {
      return {};
    }
    const builderConfig = config.builderMonetization;
    if (!builderConfig?.builderFeesEnabled) {
      throw new Error("BUILDER_FEES_DISABLED");
    }
    if (input.builderFeeHidden === "true") {
      throw new Error("BUILDER_FEE_HIDDEN");
    }
    if (!input.builderId) {
      throw new Error("BUILDER_PROFILE_MISSING");
    }
    if (!input.builderRecipient) {
      throw new Error("BUILDER_FEE_RECIPIENT_MISSING");
    }
    const feeBps = input.builderFeeBps ?? 0;
    if (feeBps > builderConfig.builderFeeMaxBps) {
      throw new Error("BUILDER_FEE_EXCEEDS_CAP");
    }
    const status = input.builderStatus ?? "ACTIVE";
    const nowIso = now().toISOString();
    const profile: BuilderProfile = {
      builderId: input.builderId,
      displayName: input.builderId,
      slug: input.builderId.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
      ownerWallet: input.builderRecipient,
      treasuryWallet: input.builderRecipient,
      verifiedStatus: "UNVERIFIED",
      allowedFeeBpsMax: builderConfig.builderFeeMaxBps,
      defaultFeeBps: feeBps,
      status,
      policyStrikeCount: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const builderFee: BuilderFeeConfig = {
      builderId: input.builderId,
      enabled: true,
      feeBps,
      recipient: input.builderRecipient,
      token: config.defaultCurrency,
      mode: input.builderFeeMode ?? builderConfig.builderFeeDefaultMode,
      capBps: builderConfig.builderFeeMaxBps,
      refundBehavior: "REFUND_PRO_RATA",
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    return { builderProfile: profile, builderFee };
  }

  function buildQuoteFeeWaterfallV2(
    quote: Omit<Quote, "feeWaterfallV2">,
    builderInput: { builderProfile?: BuilderProfile; builderFee?: BuilderFeeConfig } = {},
  ): FeeWaterfallV2 | undefined {
    const builderConfig = config.builderMonetization;
    if (!builderConfig) {
      return undefined;
    }
    const hasPlatform = Boolean(builderConfig.platformTreasury && builderConfig.platformFeeMode !== "off" && builderConfig.platformFeeBps > 0);
    const hasBuilder = Boolean(builderInput.builderFee?.enabled);
    if (!hasPlatform && !hasBuilder) {
      return undefined;
    }
    return buildFeeWaterfallV2({
      quoteId: quote.quoteId,
      grossAmount: quote.totalAtomic,
      token: config.defaultCurrency,
      decimals: 6,
      providerRecipient: quote.recipient,
      platformFeeBps: hasPlatform ? builderConfig.platformFeeBps : 0,
      platformRecipient: hasPlatform ? builderConfig.platformTreasury : undefined,
      platformMode: builderConfig.platformFeeMode,
      builderProfile: builderInput.builderProfile,
      builderFee: builderInput.builderFee,
      noDoubleChargeScope: quote.quoteId,
      directSplitEnabled: builderConfig.directSplitFeesEnabled,
      createdAt: now().toISOString(),
    });
  }

  function issueQuote(
    resource: string,
    amountAtomicOverride?: string,
    builderInput: { builderProfile?: BuilderProfile; builderFee?: BuilderFeeConfig } = {},
  ): Quote {
    const issuedAt = now();
    const quoteId = crypto.randomUUID();
    const amountAtomic = getAmountForResource(resource, amountAtomicOverride);
    const feeAtomic = calculateLegacyFeeForQuote(amountAtomic);
    const totalAtomic = amountAtomic + feeAtomic;
    const expiresAt = new Date(issuedAt.getTime() + config.quoteTtlSeconds * 1000).toISOString();
    const memoHash = hashHex(`${quoteId}:${resource}:${toAtomicString(totalAtomic)}:${expiresAt}`);

    const quoteBase: Omit<Quote, "feeWaterfallV2"> = {
      quoteId,
      resource,
      amountAtomic: toAtomicString(amountAtomic),
      feeAtomic: toAtomicString(feeAtomic),
      totalAtomic: toAtomicString(totalAtomic),
      mint: config.usdcMint,
      recipient: config.paymentRecipient,
      expiresAt,
      settlement: config.unsafeUnverifiedNettingEnabled ? ["transfer", "stream", "netting"] : ["transfer", "stream"],
      memoHash,
    };
    const feeWaterfallV2 = buildQuoteFeeWaterfallV2(quoteBase, builderInput);
    const quote: Quote = {
      ...quoteBase,
      feeWaterfallV2,
    };

    quotes.set(quoteId, quote);
    recordMarketEvent({
      type: "QUOTE_ISSUED",
      shopId: CORE_SHOP_ID,
      endpointId: endpointIdForResource(resource),
      capabilityTags: capabilityTagsForResource(resource),
      priceAmount: quote.totalAtomic,
      mint: quote.mint,
    });
    return quote;
  }

  function buildReceipt(
    commit: CommitRecord,
    quote: Quote,
    paymentProof: PaymentProof,
    verification: { settledOnchain: boolean; txSignature?: string; streamId?: string },
    binding: {
      requestId: string;
      requestDigest: string;
      responseDigest: string;
      shopId?: string;
      splitPaymentProofs?: ReceiptPayload["splitPaymentProofs"];
    },
  ): SignedReceipt {
    const feeLines = quote.feeWaterfallV2?.lines;
    const feeCollectionSummary = quote.feeWaterfallV2
      ? {
        dnaPlatformFeeStatus: quote.feeWaterfallV2.lines.find((line) => line.kind === "DNA_PLATFORM_FEE")?.collectionStatus,
        builderFeeStatus: quote.feeWaterfallV2.lines.find((line) => line.kind === "BUILDER_FEE")?.collectionStatus,
        affiliateFeeStatus: quote.feeWaterfallV2.lines.find((line) => line.kind === "AFFILIATE_FEE")?.collectionStatus,
        alphaFeeStatus: quote.feeWaterfallV2.lines.find((line) => line.kind === "ALPHA_SUCCESS_FEE")?.collectionStatus,
      }
      : undefined;
    const payload: ReceiptPayload = {
      receiptId: crypto.randomUUID(),
      quoteId: quote.quoteId,
      commitId: commit.commitId,
      resource: quote.resource,
      requestId: binding.requestId,
      requestDigest: binding.requestDigest,
      responseDigest: binding.responseDigest,
      shopId: binding.shopId ?? CORE_SHOP_ID,
      payerCommitment32B: commit.payerCommitment32B,
      recipient: quote.recipient,
      mint: quote.mint,
      amountAtomic: quote.amountAtomic,
      feeAtomic: quote.feeAtomic,
      totalAtomic: quote.totalAtomic,
      settlement: paymentProof.settlement,
      settledOnchain: verification.settledOnchain,
      txSignature: verification.txSignature,
      streamId: verification.streamId,
      splitPaymentProofs: binding.splitPaymentProofs,
      feeWaterfallHash: quote.feeWaterfallV2?.feeWaterfallHash,
      feeLines,
      feeCollectionSummary,
      createdAt: now().toISOString(),
    };

    assertImmutableRecordSafe("RECEIPT", payload);
    const signed = receiptSigner.sign(payload);
    assertImmutableRecordSafe("PROOF_RECORD", signed);
    receipts.set(payload.receiptId, signed);
    return signed;
  }

  function claimCommitDelivery(commit: CommitRecord, receiptId: string): boolean {
    if (commit.consumedAt) {
      return false;
    }
    commit.consumedAt = now().toISOString();
    commits.set(commit.commitId, commit);
    return true;
  }

  function restoreClaimedCommitDelivery(commitId: string, receiptId: string): void {
    const current = commits.get(commitId);
    if (!current || current.receiptId !== receiptId) {
      return;
    }
    current.consumedAt = undefined;
    commits.set(commitId, current);
  }

  async function tryCompatPayment(
    req: express.Request,
    res: express.Response,
    resource: string,
  ): Promise<{ handled: boolean; receipt?: SignedReceipt }> {
    const normalized = normalizeX402({
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value : value ? String(value) : undefined]),
      ),
      body: req.body,
    });

    const receivedHeaders = Object.fromEntries(
      Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : (value ?? undefined)]),
    );

    if (!normalized.required && !normalized.proof) {
      const paymentLikeHeaders = Object.keys(receivedHeaders).filter((name) => name.toLowerCase().includes("payment"));
      if (paymentLikeHeaders.length > 0) {
        sendX402Error(req, res, new X402Error(
          normalized.parseWarnings.length > 0 ? X402ErrorCode.X402_PARSE_FAILED : X402ErrorCode.X402_UNSUPPORTED_DIALECT,
          {
            details: { warnings: normalized.parseWarnings },
          },
        ), {
          dialectDetected: normalized.style,
          missing: ["PAYMENT-REQUIRED", "PAYMENT-SIGNATURE"],
        });
        return { handled: true };
      }
      return { handled: false };
    }

    logRequestHeaders("x402_compat_attempt", receivedHeaders, {
      traceId: req.traceId,
      route: resource,
    });

    if (!normalized.required) {
      sendX402Error(req, res, new X402Error(X402ErrorCode.X402_MISSING_PAYMENT_REQUIRED, {
        details: { warnings: normalized.parseWarnings },
      }), {
        dialectDetected: normalized.style,
        missing: ["PAYMENT-REQUIRED|X-PAYMENT-REQUIRED|X-402-PAYMENT-REQUIRED"],
        paymentProof: normalized.proof,
      });
      return { handled: true };
    }

    if (!normalized.proof) {
      sendX402Error(req, res, new X402Error(X402ErrorCode.X402_MISSING_PAYMENT_PROOF, {
        details: { warnings: normalized.parseWarnings },
      }), {
        dialectDetected: normalized.style,
        missing: ["PAYMENT-SIGNATURE|X-PAYMENT|X-402-PAYMENT"],
        paymentRequired: normalized.required,
      });
      return { handled: true };
    }

    if (normalized.required.network !== "solana" && normalized.required.network !== "unknown") {
      sendX402Error(req, res, new X402Error(X402ErrorCode.X402_UNSUPPORTED_NETWORK), {
        dialectDetected: normalized.style,
        paymentRequired: normalized.required,
      });
      return { handled: true };
    }

    if (normalized.required.currency.toUpperCase() !== config.defaultCurrency.toUpperCase()) {
      sendX402Error(req, res, new X402Error(X402ErrorCode.X402_UNSUPPORTED_CURRENCY), {
        dialectDetected: normalized.style,
        paymentRequired: normalized.required,
      });
      return { handled: true };
    }

    if (!/^\d+$/.test(normalized.required.amountAtomic) || BigInt(normalized.required.amountAtomic) <= 0n) {
      sendX402Error(req, res, new X402Error(X402ErrorCode.X402_INVALID_AMOUNT), {
        dialectDetected: normalized.style,
        paymentRequired: normalized.required,
      });
      return { handled: true };
    }

    if (!normalized.required.recipient || normalized.required.recipient.length < 16) {
      sendX402Error(req, res, new X402Error(X402ErrorCode.X402_INVALID_RECIPIENT), {
        dialectDetected: normalized.style,
        paymentRequired: normalized.required,
      });
      return { handled: true };
    }

    if (normalized.required.expiresAt && normalized.required.expiresAt < now().getTime()) {
      sendX402Error(req, res, new X402Error(X402ErrorCode.X402_EXPIRED_REQUIREMENTS), {
        dialectDetected: normalized.style,
        paymentRequired: normalized.required,
      });
      return { handled: true };
    }

    const proof = normalized.proof;
    if (!proof.txSig && !proof.proofBlob) {
      sendX402Error(req, res, new X402Error(X402ErrorCode.X402_PROOF_INVALID), {
        dialectDetected: normalized.style,
        paymentRequired: normalized.required,
        paymentProof: proof,
      });
      return { handled: true };
    }

    if (proof.recipient && proof.recipient !== normalized.required.recipient) {
      sendX402Error(req, res, new X402Error(X402ErrorCode.X402_REQUIRED_PROOF_MISMATCH), {
        dialectDetected: normalized.style,
        paymentRequired: normalized.required,
        paymentProof: proof,
      });
      return { handled: true };
    }

    if (proof.amountAtomic && proof.amountAtomic !== normalized.required.amountAtomic) {
      sendX402Error(req, res, new X402Error(X402ErrorCode.X402_REQUIRED_PROOF_MISMATCH), {
        dialectDetected: normalized.style,
        paymentRequired: normalized.required,
        paymentProof: proof,
      });
      return { handled: true };
    }

    if (proof.currency && proof.currency.toUpperCase() !== normalized.required.currency.toUpperCase()) {
      sendX402Error(req, res, new X402Error(X402ErrorCode.X402_REQUIRED_PROOF_MISMATCH), {
        dialectDetected: normalized.style,
        paymentRequired: normalized.required,
        paymentProof: proof,
      });
      return { handled: true };
    }

    const quote: Quote = {
      quoteId: `compat-${crypto.randomUUID()}`,
      resource,
      amountAtomic: normalized.required.amountAtomic,
      feeAtomic: "0",
      totalAtomic: normalized.required.amountAtomic,
      mint: normalized.required.settlement.mint ?? config.usdcMint,
      recipient: normalized.required.recipient,
      expiresAt: normalized.required.expiresAt
        ? new Date(normalized.required.expiresAt).toISOString()
        : new Date(now().getTime() + config.quoteTtlSeconds * 1000).toISOString(),
      settlement: config.unsafeUnverifiedNettingEnabled ? ["transfer", "netting"] : ["transfer"],
      memoHash: hashHex(JSON.stringify(normalized.required)),
    };

    if (!enforceGuardSpend(req, res, {
      resource,
      amountAtomic: quote.totalAtomic,
      stage: "compat",
    })) {
      return { handled: true };
    }

    const paymentProof = proofToPaymentProof(proof, normalized.required);
    const verification = await verifyPaymentForQuote(quote, paymentProof);
    if (!verification.ok) {
      sendX402Error(req, res, new X402Error(verifierErrorCode(verification), {
        cause: verification.error ?? "payment verification failed",
      }), {
        dialectDetected: normalized.style,
        paymentRequired: normalized.required,
        paymentProof: proof,
      });
      return { handled: true };
    }

    if (paymentProof.settlement === "transfer" && !verification.txSignature) {
      sendX402Error(req, res, new X402Error(X402ErrorCode.X402_PROOF_INVALID, {
        cause: "verified transfer settlement is missing canonical txSignature",
      }), {
        dialectDetected: normalized.style,
        paymentRequired: normalized.required,
        paymentProof: proof,
      });
      return { handled: true };
    }

    if (paymentProof.settlement === "transfer" && verification.txSignature) {
      const globalReplayKey = createGlobalProofReplayKey({
        shopId: CORE_SHOP_ID,
        proofId: verification.txSignature,
        settlement: "transfer",
      });
      if (!replayStore.consume(globalReplayKey, now().getTime())) {
        recordGuardReplay(req, resource, "x402_global_replay_detected");
        sendX402Error(req, res, new X402Error(X402ErrorCode.X402_REPLAY_DETECTED), {
          dialectDetected: normalized.style,
          paymentRequired: normalized.required,
          paymentProof: proof,
        });
        return { handled: true };
      }

      const compatProofReplayId = proof.txSig
        ?? verification.txSignature
        ?? `compat-proof:${hashHex(JSON.stringify(proof))}`;
      const proofReplayKey = createReplayKey({
        shopId: CORE_SHOP_ID,
        txSig: compatProofReplayId,
        amountAtomic: quote.totalAtomic,
        recipient: quote.recipient,
        mint: quote.mint,
      });
      if (!replayStore.consume(proofReplayKey, now().getTime())) {
        recordGuardReplay(req, resource, "x402_replay_detected");
        sendX402Error(req, res, new X402Error(X402ErrorCode.X402_REPLAY_DETECTED), {
          dialectDetected: normalized.style,
          paymentRequired: normalized.required,
          paymentProof: proof,
        });
        return { handled: true };
      }

      const canonicalKey = createReplayKey({
        shopId: CORE_SHOP_ID,
        txSig: verification.txSignature,
        amountAtomic: quote.totalAtomic,
        recipient: quote.recipient,
        mint: quote.mint,
      });
      if (canonicalKey !== proofReplayKey && !replayStore.consume(canonicalKey, now().getTime())) {
        recordGuardReplay(req, resource, "x402_replay_detected");
        sendX402Error(req, res, new X402Error(X402ErrorCode.X402_REPLAY_DETECTED), {
          dialectDetected: normalized.style,
          paymentRequired: normalized.required,
          paymentProof: proof,
        });
        return { handled: true };
      }
    }

    const syntheticCommit: CommitRecord = {
      commitId: crypto.randomUUID(),
      quoteId: quote.quoteId,
      payerCommitment32B: normalizeCommitment32B(
        `0x${hashHex(`${verification.txSignature ?? proof.proofBlob ?? crypto.randomUUID()}`)}`,
      ),
      createdAt: now().toISOString(),
      status: "finalized",
      settlementMode: paymentProof.settlement,
    };

    const requestDigest = computeRequestDigest({
      method: req.method,
      path: req.originalUrl ?? req.path,
      body: requestBodyForDigest(req),
    });
    const responseBody = fulfilledResponseBody(resource);
    const responseDigest = computeResponseDigest({ status: 200, body: responseBody });

    const receipt = buildReceipt(syntheticCommit, quote, paymentProof, verification, {
      requestId: req.traceId ?? syntheticCommit.commitId,
      requestDigest,
      responseDigest,
      shopId: CORE_SHOP_ID,
    });
    const receiptValid = verifySignedReceipt(receipt);
    guard?.ledger.commitSpend(observeGuardActor(req), quote.totalAtomic, now());
    recordGuardReceiptVerification(req, resource, receipt.payload.receiptId, receiptValid, receiptValid ? undefined : "receipt_signature_invalid");
    recordGuardDelivery(resource, 0, 200, receipt.payload.receiptId, receiptValid);

    recordMarketEvent({
      type: "PAYMENT_VERIFIED",
      shopId: CORE_SHOP_ID,
      endpointId: endpointIdForResource(resource),
      capabilityTags: capabilityTagsForResource(resource),
      priceAmount: quote.totalAtomic,
      mint: quote.mint,
      settlementMode: paymentProof.settlement,
      receiptId: receipt.payload.receiptId,
      anchor32: receipt.payload.payerCommitment32B,
      buyerCommitment32B: receipt.payload.payerCommitment32B,
      anchored: false,
      verificationTier: "FAST",
      receiptValid,
    });

    context.anchoringQueue?.enqueue({
      receiptId: receipt.payload.receiptId,
      anchor32: receipt.payload.payerCommitment32B,
      shopId: CORE_SHOP_ID,
      endpointId: endpointIdForResource(resource),
      capabilityTags: capabilityTagsForResource(resource),
      priceAmount: quote.totalAtomic,
      mint: quote.mint,
      settlementMode: paymentProof.settlement,
    });

    recordMarketEvent({
      type: "REQUEST_FULFILLED",
      shopId: CORE_SHOP_ID,
      endpointId: endpointIdForResource(resource),
      capabilityTags: capabilityTagsForResource(resource),
      priceAmount: quote.totalAtomic,
      mint: quote.mint,
      settlementMode: paymentProof.settlement,
      statusCode: 200,
      receiptId: receipt.payload.receiptId,
      anchor32: receipt.payload.payerCommitment32B,
      anchored: false,
      verificationTier: "FAST",
      receiptValid,
    });

    const body = {
      ...responseBody,
      receipt,
    };

    res.json(body);
    return { handled: true, receipt };
  }

  app.use(cors());
  app.use(traceIdMiddleware);
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: string }).rawBody = buf.toString("utf8");
    },
  }));
  app.use(requireHttpsMiddleware({ allowInsecure: config.allowInsecure ?? false }));
  app.use("/market", marketRouter);

  const adminRouter = createAdminRouter({
    context,
    auditLog,
    config,
    adminSecret: config.adminSecret,
  });
  app.use("/admin", adminRouter);
  if (guard) {
    app.use("/guard", guard.router());
  }

  auditLog.record({ kind: "CONFIG_LOADED", meta: {
    cluster: config.cluster,
    mint: config.usdcMint,
    recipient: config.paymentRecipient,
    anchoringEnabled: config.anchoringEnabled,
  }});

  function sendAgentError(res: express.Response, error: unknown): void {
    if (error instanceof AgentTradingError) {
      res.status(error.status).json({ ok: false, error: error.code, message: error.message });
      return;
    }
    res.status(500).json({ ok: false, error: "agent_control_plane_failed", message: error instanceof Error ? error.message : String(error) });
  }

  function sendAgentBuilderError(res: express.Response, error: unknown): void {
    if (error instanceof AgentBuilderError) {
      res.status(error.status).json({ ok: false, error: error.code, message: error.message });
      return;
    }
    res.status(500).json({ ok: false, error: "agent_builder_failed", message: error instanceof Error ? error.message : String(error) });
  }

  function requirePublicBetaFeature(
    res: express.Response,
    feature: "agentCreation" | "paperAgents" | "publicAgentProfiles" | "copySettings" | "alphaMonetization",
    label: string,
  ): boolean {
    const beta = config.publicBeta;
    if (beta?.enabled && beta[feature]) {
      return true;
    }
    res.status(404).json({
      ok: false,
      error: "PUBLIC_BETA_FEATURE_UNAVAILABLE",
      message: `${label} is not in beta scope for this deployment.`,
    });
    return false;
  }

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      cluster: inferNetworkLabel(config.solanaRpcUrl),
      build: {
        version: config.appVersion,
        commit: config.buildCommit ?? null,
      },
      mint: config.usdcMint,
      recipient: config.paymentRecipient,
      defaultCurrency: config.defaultCurrency,
      enabledPricingModels: config.enabledPricingModels,
      marketplaceSelection: config.marketplaceSelection,
      feePolicy: {
        baseFeeAtomic: toAtomicString(config.feePolicy.baseFeeAtomic),
        feeBps: config.feePolicy.feeBps,
        minFeeAtomic: toAtomicString(config.feePolicy.minFeeAtomic),
        accrueThresholdAtomic: toAtomicString(config.feePolicy.accrueThresholdAtomic),
        minSettleAtomic: toAtomicString(config.feePolicy.minSettleAtomic),
      },
      market: {
        signer: market.signerPublicKey,
        registeredShops: market.registry.list().length,
        disabledShops: config.disabledShops,
        eventsIndexed: market.storage.all().length,
        paused: market.pauseMarket,
        ordersPaused: market.pauseOrders,
      },
      runtime: {
        auditFixturesEnabled,
        gauntletMode: Boolean(config.gauntletMode),
      },
      guard: {
        enabled: Boolean(guard),
        failMode: guardConfig.failMode,
        windowMs: guardConfig.windowMs,
        snapshotPath: guardConfig.snapshotPath ?? null,
        spendCeilings: guardConfig.spendCeilings,
        summary: guard?.ledger.summary() ?? null,
      },
      anchoring: {
        enabled: Boolean(context.anchoringQueue),
        programId: anchorProgramId,
        anchorProgramId,
        protocolProgramId,
        anchorProgramOk,
        altAddress: config.anchoringAltAddress ?? null,
        pending: context.anchoringQueue?.getPendingCount() ?? 0,
        anchored: context.anchoringQueue?.getAnchoredCount() ?? 0,
        recentSignatures: context.anchoringQueue?.recentSignatures(5) ?? [],
      },
      programs: {
        paymentProgramId: config.paymentProgramId ?? null,
        pdxDarkProtocolProgramId: protocolProgramId,
        receiptAnchorProgramId: anchorProgramId,
      },
      pauseFlags: {
        market: config.pauseMarket,
        orders: config.pauseOrders,
        finalize: config.pauseFinalize,
      },
      signer: receiptSigner.signerPublicKey,
    });
  });

  app.get("/health/db", (_req, res) => {
    const configured = Boolean(config.databaseUrl);
    res.status(configured ? 200 : 503).json({
      ok: configured,
      configured,
      message: configured ? "database configuration present" : "DATABASE_URL is not configured",
    });
  });

  app.get("/health/policy", (_req, res) => {
    res.json({
      ok: true,
      policyVersion: config.policyVersion ?? "policy-v1",
      auditEvents: market.policyAuditEvents.length,
    });
  });

  app.get("/health/verifier", (_req, res) => {
    res.json({
      ok: true,
      liveMoneyMovementEnabled: Boolean(config.liveMoneyMovementEnabled),
      settlementVerifier: "configured",
    });
  });

  app.get("/health/settlement", (_req, res) => {
    res.json({
      ok: true,
      defaultCurrency: config.defaultCurrency,
      mint: config.usdcMint,
      liveMoneyMovementEnabled: Boolean(config.liveMoneyMovementEnabled),
      publicNettingEnabled: Boolean(config.publicNettingEnabled),
    });
  });

  app.get("/health/webhooks", (_req, res) => {
    res.json({
      ok: Boolean(config.webhookSigningSecret),
      configured: Boolean(config.webhookSigningSecret),
    });
  });

  app.get("/health/queue", (_req, res) => {
    res.json({
      ok: true,
      anchoringPending: context.anchoringQueue?.getPendingCount() ?? 0,
    });
  });

  app.get("/health/receipts", (_req, res) => {
    res.json({
      ok: true,
      receipts: receipts.size,
      signer: receiptSigner.signerPublicKey,
    });
  });

  app.post("/v1/agent-builder/draft", async (req, res) => {
    if (!requirePublicBetaFeature(res, "agentCreation", "Agent Builder")) return;
    const parsed = agentBuilderRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_agent_builder_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const result = await agentBuilder.createDraft(parsed.data as AgentBuilderRequest);
      auditLog.record({
        kind: result.status === "REJECTED" ? "AGENT_BUILDER_DRAFT_REJECTED" : "AGENT_BUILDER_DRAFT_CREATED",
        meta: {
          draftId: result.draftId,
          ownerWallet: parsed.data.ownerWallet,
          inputMode: parsed.data.inputMode,
          status: result.status,
          reasonCodes: result.reasonCodes,
        },
      });
      res.status(result.status === "REJECTED" ? 422 : 201).json({ ok: result.status !== "REJECTED", ...result });
    } catch (error) {
      sendAgentBuilderError(res, error);
    }
  });

  app.get("/v1/agent-builder/drafts/:draftId", async (req, res) => {
    if (!requirePublicBetaFeature(res, "agentCreation", "Agent Builder drafts")) return;
    const draft = await agentBuilder.getDraft(req.params.draftId);
    if (!draft) {
      res.status(404).json({ ok: false, error: "agent_builder_draft_not_found" });
      return;
    }
    res.json({ ok: true, draft });
  });

  app.post("/v1/agent-builder/drafts/:draftId/confirm", async (req, res) => {
    if (!requirePublicBetaFeature(res, "agentCreation", "Agent Builder confirmation")) return;
    const parsed = agentBuilderConfirmSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_agent_builder_confirm", details: parsed.error.flatten() });
      return;
    }
    try {
      const result = await agentBuilder.confirmDraft({ draftId: req.params.draftId, ...parsed.data });
      observedAgentIds.add(result.agentConfig.slug);
      auditLog.record({
        kind: "AGENT_BUILDER_DRAFT_CONFIRMED",
        meta: {
          draftId: req.params.draftId,
          ownerWallet: parsed.data.ownerWallet,
          agentType: result.agentConfig.agentType,
          mode: result.agentConfig.mode,
          riskLevel: result.riskSummary.riskLevel,
        },
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      sendAgentBuilderError(res, error);
    }
  });

  app.post("/v1/agent-builder/drafts/:draftId/reject", async (req, res) => {
    if (!requirePublicBetaFeature(res, "agentCreation", "Agent Builder drafts")) return;
    const parsed = agentBuilderRejectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_agent_builder_reject", details: parsed.error.flatten() });
      return;
    }
    try {
      const draft = await agentBuilder.rejectDraft(req.params.draftId, parsed.data.ownerWallet);
      auditLog.record({ kind: "AGENT_BUILDER_DRAFT_REJECTED", meta: { draftId: req.params.draftId, ownerWallet: draft.ownerWallet } });
      res.json({ ok: true, draft });
    } catch (error) {
      sendAgentBuilderError(res, error);
    }
  });

  app.get("/v1/agent-builder/templates", async (_req, res) => {
    if (!requirePublicBetaFeature(res, "agentCreation", "Agent Builder templates")) return;
    res.json({ ok: true, templates: await agentBuilder.listTemplates() });
  });

  app.get("/v1/agent-builder/guided-tree", (_req, res) => {
    if (!requirePublicBetaFeature(res, "agentCreation", "Agent Builder guided tree")) return;
    res.json({ ok: true, tree: agentBuilder.guidedTree() });
  });

  app.post("/v1/agent-builder/recipes", async (req, res) => {
    if (!requirePublicBetaFeature(res, "agentCreation", "Agent Builder recipes")) return;
    const parsed = agentRecipeCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_agent_recipe", details: parsed.error.flatten() });
      return;
    }
    try {
      const recipe = await agentBuilder.createRecipe(parsed.data);
      auditLog.record({ kind: "AGENT_RECIPE_CREATED", meta: { recipeId: recipe.recipeId, ownerWallet: parsed.data.ownerWallet, visibility: recipe.visibility } });
      res.status(201).json({ ok: true, recipe });
    } catch (error) {
      sendAgentBuilderError(res, error);
    }
  });

  app.get("/v1/agent-builder/recipes/public", async (_req, res) => {
    if (!requirePublicBetaFeature(res, "agentCreation", "Agent Builder public recipes")) return;
    res.json({ ok: true, recipes: await agentBuilder.publicRecipes() });
  });

  app.get("/v1/agent-builder/recipes/:recipeId", async (req, res) => {
    if (!requirePublicBetaFeature(res, "agentCreation", "Agent Builder recipes")) return;
    const recipe = await agentBuilder.getRecipe(req.params.recipeId);
    if (!recipe) {
      res.status(404).json({ ok: false, error: "agent_recipe_not_found" });
      return;
    }
    res.json({ ok: true, recipe });
  });

  app.post("/v1/agent-builder/recipes/:recipeId/clone", async (req, res) => {
    if (!requirePublicBetaFeature(res, "agentCreation", "Agent Builder recipe clone")) return;
    const parsed = agentRecipeCloneSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_agent_recipe_clone", details: parsed.error.flatten() });
      return;
    }
    try {
      const result = await agentBuilder.cloneRecipe(req.params.recipeId, parsed.data.ownerWallet);
      auditLog.record({
        kind: "AGENT_RECIPE_CLONED",
        meta: { recipeId: req.params.recipeId, draftId: result.draftId, ownerWallet: parsed.data.ownerWallet, status: result.status },
      });
      res.status(result.status === "REJECTED" ? 422 : 201).json({ ok: result.status !== "REJECTED", ...result });
    } catch (error) {
      sendAgentBuilderError(res, error);
    }
  });

  app.post("/v1/agents/:agentId/wallets/register", async (req, res) => {
    if (!requirePublicBetaFeature(res, "agentCreation", "Agent wallet registration")) return;
    const parsed = agentWalletRegistrationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_agent_wallet_registration", details: parsed.error.flatten() });
      return;
    }
    try {
      const wallet = await agentTrading.registerWallet(req.params.agentId, parsed.data as AgentWalletRegistrationInput);
      observedAgentIds.add(req.params.agentId);
      auditLog.record({
        kind: "AGENT_WALLET_REGISTERED",
        meta: {
          agentId: req.params.agentId,
          ownerWallet: wallet.ownerWallet,
          publicKey: wallet.publicKey,
          custodyModel: wallet.custodyModel,
          backendHasPrivateKey: wallet.backendHasPrivateKey,
        },
      });
      res.status(201).json({ ok: true, wallet });
    } catch (error) {
      sendAgentError(res, error);
    }
  });

  app.get("/v1/agents/:agentId/wallets", async (req, res) => {
    if (!requirePublicBetaFeature(res, "agentCreation", "Agent wallets")) return;
    res.json({ ok: true, wallets: await agentTrading.listWallets(req.params.agentId) });
  });

  app.post("/v1/agents/:agentId/paper-account", async (req, res) => {
    if (!requirePublicBetaFeature(res, "paperAgents", "Paper agents")) return;
    const account = await agentTrading.createPaperAccount(req.params.agentId);
    observedAgentIds.add(req.params.agentId);
    auditLog.record({ kind: "PAPER_AGENT_ACCOUNT_CREATED", meta: { agentId: req.params.agentId } });
    res.status(201).json({ ok: true, account, badge: "PAPER" });
  });

  app.get("/v1/agents/:agentId/paper-account", async (req, res) => {
    if (!requirePublicBetaFeature(res, "paperAgents", "Paper agents")) return;
    const account = await agentTrading.getPaperAccount(req.params.agentId);
    if (!account) {
      res.status(404).json({ ok: false, error: "paper_account_not_found" });
      return;
    }
    res.json({ ok: true, account, badge: "PAPER" });
  });

  app.post("/v1/agents/:agentId/paper-trades", async (req, res) => {
    if (!requirePublicBetaFeature(res, "paperAgents", "Paper trading")) return;
    const parsed = paperTradeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_paper_trade", details: parsed.error.flatten() });
      return;
    }
    try {
      const result = await agentTrading.recordPaperTrade(req.params.agentId, parsed.data as PaperTradeInput);
      observedAgentIds.add(req.params.agentId);
      auditLog.record({
        kind: "PAPER_TRADE_RECORDED",
        meta: { agentId: req.params.agentId, marketId: result.event.marketId, amountAtomic: result.event.amountAtomic },
      });
      res.status(201).json({ ok: true, ...result, realSettlement: false, token: "PAPER_USDC" });
    } catch (error) {
      sendAgentError(res, error);
    }
  });

  app.get("/v1/agents/:agentId/profile", async (req, res) => {
    if (!requirePublicBetaFeature(res, "publicAgentProfiles", "Agent profiles")) return;
    res.json({ ok: true, profile: await agentTrading.profile(req.params.agentId) });
  });

  app.patch("/v1/agents/:agentId/profile", async (req, res) => {
    if (!requirePublicBetaFeature(res, "publicAgentProfiles", "Agent profiles")) return;
    const parsed = profilePatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_agent_profile_patch", details: parsed.error.flatten() });
      return;
    }
    const profile = await agentTrading.updateProfile(req.params.agentId, parsed.data);
    observedAgentIds.add(req.params.agentId);
    auditLog.record({ kind: "AGENT_PROFILE_UPDATED", meta: { agentId: req.params.agentId, visibility: profile.visibility } });
    res.json({ ok: true, profile });
  });

  app.get("/v1/leaderboard", async (_req, res) => {
    if (!requirePublicBetaFeature(res, "publicAgentProfiles", "Agent leaderboard")) return;
    res.json({ ok: true, agents: await agentTrading.leaderboard() });
  });

  app.post("/v1/agents/:agentId/monetization", async (req, res) => {
    if (!requirePublicBetaFeature(res, "alphaMonetization", "Alpha monetization")) return;
    const parsed = alphaMonetizationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_alpha_monetization", details: parsed.error.flatten() });
      return;
    }
    try {
      const monetization = await agentTrading.setMonetization(req.params.agentId, parsed.data);
      observedAgentIds.add(req.params.agentId);
      auditLog.record({
        kind: "ALPHA_MONETIZATION_UPDATED",
        meta: { agentId: req.params.agentId, enabled: monetization.enabled, successFeeBps: monetization.successFeeBps, mode: monetization.mode },
      });
      res.json({ ok: true, monetization });
    } catch (error) {
      sendAgentError(res, error);
    }
  });

  app.get("/v1/agents/:agentId/monetization", async (req, res) => {
    if (!requirePublicBetaFeature(res, "alphaMonetization", "Alpha monetization")) return;
    res.json({ ok: true, monetization: await agentTrading.getMonetization(req.params.agentId) ?? null });
  });

  app.post("/v1/copy/settings", async (req, res) => {
    if (!requirePublicBetaFeature(res, "copySettings", "Copy settings")) return;
    const parsed = copySettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_copy_settings", details: parsed.error.flatten() });
      return;
    }
    try {
      const settings = await agentTrading.createCopySettings(parsed.data);
      observedAgentIds.add(settings.followerAgentId);
      observedAgentIds.add(settings.sourceAgentId);
      auditLog.record({
        kind: "COPY_SETTINGS_CREATED",
        meta: { copySettingsId: settings.copySettingsId, followerAgentId: settings.followerAgentId, sourceAgentId: settings.sourceAgentId, mode: settings.mode },
      });
      res.status(201).json({ ok: true, settings });
    } catch (error) {
      sendAgentError(res, error);
    }
  });

  app.get("/v1/copy/settings/:copySettingsId", async (req, res) => {
    if (!requirePublicBetaFeature(res, "copySettings", "Copy settings")) return;
    const settings = await agentTrading.getCopySettings(req.params.copySettingsId);
    if (!settings) {
      res.status(404).json({ ok: false, error: "copy_settings_not_found" });
      return;
    }
    res.json({ ok: true, settings });
  });

  app.patch("/v1/copy/settings/:copySettingsId", async (req, res) => {
    if (!requirePublicBetaFeature(res, "copySettings", "Copy settings")) return;
    const parsed = copySettingsSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_copy_settings_patch", details: parsed.error.flatten() });
      return;
    }
    try {
      const settings = await agentTrading.updateCopySettings(req.params.copySettingsId, parsed.data as Partial<CopySettings>);
      auditLog.record({ kind: "COPY_SETTINGS_UPDATED", meta: { copySettingsId: settings.copySettingsId, enabled: settings.enabled, mode: settings.mode } });
      res.json({ ok: true, settings });
    } catch (error) {
      sendAgentError(res, error);
    }
  });

  app.post("/v1/copy/settings/:copySettingsId/pause", async (req, res) => {
    if (!requirePublicBetaFeature(res, "copySettings", "Copy settings")) return;
    try {
      const settings = await agentTrading.pauseCopySettings(req.params.copySettingsId);
      auditLog.record({ kind: "COPY_SETTINGS_PAUSED", meta: { copySettingsId: settings.copySettingsId } });
      res.json({ ok: true, settings });
    } catch (error) {
      sendAgentError(res, error);
    }
  });

  app.post("/v1/copy/decide", async (req, res) => {
    if (!requirePublicBetaFeature(res, "copySettings", "Copy decisions")) return;
    const parsed = copyDecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_copy_decision_input", details: parsed.error.flatten() });
      return;
    }
    try {
      const result = await agentTrading.decide({
        ...(parsed.data as CopyDecisionInput),
        emergencyPaused: parsed.data.emergencyPaused
          ?? (context.emergencyPause.isPaused("marketplacePaused") || context.emergencyPause.isPaused("finalizePaused")),
      });
      auditLog.record({
        kind: "COPY_DECISION_EVALUATED",
        meta: {
          decision: result.decision.decision,
          reasonCodes: result.decision.reasonCodes,
          sourceAgentId: parsed.data.sourceAction.sourceAgentId,
          copiedLotId: result.copiedLot?.copiedLotId,
        },
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      sendAgentError(res, error);
    }
  });

  app.get("/v1/copy/lots/:copiedLotId", async (req, res) => {
    if (!requirePublicBetaFeature(res, "copySettings", "Copied lots")) return;
    const lot = await agentTrading.getCopiedLot(req.params.copiedLotId);
    if (!lot) {
      res.status(404).json({ ok: false, error: "copied_lot_not_found" });
      return;
    }
    res.json({ ok: true, lot });
  });

  app.get("/v1/agents/:agentId/copied-lots", async (req, res) => {
    if (!requirePublicBetaFeature(res, "copySettings", "Copied lots")) return;
    res.json({ ok: true, lots: await agentTrading.listCopiedLots(req.params.agentId) });
  });

  app.post("/v1/copy/lots/:copiedLotId/finalize", async (req, res) => {
    if (!requirePublicBetaFeature(res, "copySettings", "Copied lot finalization")) return;
    const parsed = copiedLotFinalizeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_copied_lot_finalize", details: parsed.error.flatten() });
      return;
    }
    try {
      const result = await agentTrading.finalizeCopiedLot(req.params.copiedLotId, parsed.data);
      auditLog.record({
        kind: "COPIED_LOT_FINALIZED",
        meta: {
          copiedLotId: result.lot.copiedLotId,
          status: result.lot.status,
          realizedPnlAtomic: result.lot.realizedPnlAtomic,
          alphaFeeAccrualId: result.alphaFeeAccrual?.accrualId,
        },
      });
      res.json({ ok: true, ...result });
    } catch (error) {
      sendAgentError(res, error);
    }
  });

  app.get("/metrics", (_req, res) => {
    res.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
    res.send(renderX402Metrics(context, auditLog));
  });

  app.post("/internal/alerts/telegram", async (req, res) => {
    const telegram = config.telegramAlerts;
    if (!telegram?.enabled) {
      res.status(404).json({ ok: false, error: "not_found" });
      return;
    }

    const expectedSecret = telegram.relaySecret;
    const providedSecret = req.header("x-alert-relay-secret") ?? bearerToken(req.header("authorization"));
    if (!expectedSecret || !providedSecret || !timingSafeEqualString(expectedSecret, providedSecret)) {
      res.status(403).json({ ok: false, error: "alert_relay_forbidden" });
      return;
    }

    if (!telegram.botToken || !telegram.chatId) {
      res.status(503).json({ ok: false, error: "telegram_alert_route_not_configured" });
      return;
    }

    const parsed = alertmanagerWebhookPayloadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_alertmanager_payload", details: parsed.error.flatten() });
      return;
    }

    try {
      assertImmutableRecordSafe("WEBHOOK_IMMUTABLE_LOG", {
        channel: "telegram",
        receiver: parsed.data.receiver,
        status: parsed.data.status,
        alerts: parsed.data.alerts,
      });
      const result = await relayAlertmanagerToTelegram({
        config: {
          botToken: telegram.botToken,
          chatId: telegram.chatId,
          parseMode: telegram.parseMode,
          environment: config.nodeEnv ?? "staging",
        },
        payload: parsed.data,
      });
      auditLog.record({
        kind: result.ok ? "WEBHOOK_SENT" : "WEBHOOK_FAILED",
        meta: {
          channel: "telegram",
          delivered: result.delivered.map((item) => item.alertName),
          failed: result.failed.map((item) => item.alertName),
        },
      });
      res.status(result.ok ? 202 : 502).json({
        ok: result.ok,
        channel: "telegram",
        delivered: result.delivered,
        failed: result.failed,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "telegram alert relay failed";
      auditLog.record({
        kind: "WEBHOOK_FAILED",
        meta: { channel: "telegram", reason: message },
      });
      const status = message.includes("PII") || message.includes("immutable") ? 400 : 502;
      res.status(status).json({ ok: false, error: "telegram_alert_relay_failed", reason: message });
    }
  });

  app.post("/v1/webhooks/receiver-test", async (req, res) => {
    const receiverEnabled = runtimeGates.webhookReceiverTest
      && (config.nodeEnv ?? "development").toLowerCase() !== "production"
      && !runtimeGates.prodMoney;
    if (!receiverEnabled) {
      res.status(404).json({ ok: false, error: "not_found" });
      return;
    }

    if (!config.webhookSigningSecret) {
      res.status(503).json({ ok: false, error: "webhook_signing_secret_missing" });
      return;
    }

    const parsed = signedWebhookEnvelopeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_webhook_envelope", details: parsed.error.flatten() });
      return;
    }

    const envelope = parsed.data as SignedWebhookEnvelope;
    const immutableLogPayload = {
      idempotencyKey: envelope.idempotencyKey,
      event: envelope.event,
      timestamp: envelope.timestamp,
      payload: envelope.payload,
    };

    try {
      assertImmutableRecordSafe("WEBHOOK_IMMUTABLE_LOG", immutableLogPayload);
      verifyWebhookSignatureAndTimestamp(config.webhookSigningSecret, envelope, now());
      const claimed = await webhookReplayClaimStore.claim({
        idempotencyKey: envelope.idempotencyKey,
        event: envelope.event,
        timestamp: envelope.timestamp,
      });
      if (!claimed) {
        auditLog.record({
          kind: "WEBHOOK_REPLAY_REJECTED",
          meta: { idempotencyKey: envelope.idempotencyKey, event: envelope.event },
        });
        res.status(409).json({ ok: false, error: "duplicate_webhook_rejected" });
        return;
      }

      auditLog.record({
        kind: "WEBHOOK_RECEIVED",
        meta: { idempotencyKey: envelope.idempotencyKey, event: envelope.event },
      });
      res.status(202).json({ ok: true, idempotencyKey: envelope.idempotencyKey });
    } catch (error) {
      const message = error instanceof Error ? error.message : "webhook rejected";
      auditLog.record({
        kind: message.includes("duplicate") ? "WEBHOOK_REPLAY_REJECTED" : "WEBHOOK_FAILED",
        meta: { idempotencyKey: envelope.idempotencyKey, event: envelope.event, reason: message },
      });
      const status = message.includes("signature")
        ? 401
        : message.includes("timestamp")
          ? 400
          : message.includes("PII") || message.includes("immutable")
            ? 400
            : 422;
      res.status(status).json({ ok: false, error: "webhook_rejected", reason: message });
    }
  });

  app.get("/status", (_req, res) => {
    res.json({
      ok: true,
      cluster: inferNetworkLabel(config.solanaRpcUrl),
      build: {
        version: config.appVersion,
        commit: config.buildCommit ?? null,
      },
      programs: {
        paymentProgramId: config.paymentProgramId ?? null,
        pdxDarkProtocolProgramId: protocolProgramId,
        receiptAnchorProgramId: anchorProgramId,
      },
      anchoring: {
        enabled: Boolean(context.anchoringQueue),
        programId: anchorProgramId,
        anchorProgramId,
        protocolProgramId,
        anchorProgramOk,
        pending: context.anchoringQueue?.getPendingCount() ?? 0,
        anchored: context.anchoringQueue?.getAnchoredCount() ?? 0,
      },
      feePolicy: {
        baseFeeAtomic: toAtomicString(config.feePolicy.baseFeeAtomic),
        feeBps: config.feePolicy.feeBps,
        minFeeAtomic: toAtomicString(config.feePolicy.minFeeAtomic),
        accrueThresholdAtomic: toAtomicString(config.feePolicy.accrueThresholdAtomic),
        minSettleAtomic: toAtomicString(config.feePolicy.minSettleAtomic),
      },
      pauseFlags: {
        market: config.pauseMarket,
        orders: config.pauseOrders,
        finalize: config.pauseFinalize,
      },
      market: {
        registeredShops: market.registry.list().length,
        disabledShops: config.disabledShops,
        eventsIndexed: market.storage.all().length,
      },
      runtime: {
        auditFixturesEnabled,
        gauntletMode: Boolean(config.gauntletMode),
      },
      guard: {
        enabled: Boolean(guard),
        failMode: guardConfig.failMode,
        windowMs: guardConfig.windowMs,
        snapshotPath: guardConfig.snapshotPath ?? null,
        spendCeilings: guardConfig.spendCeilings,
        summary: guard?.ledger.summary() ?? null,
      },
    });
  });

  app.get("/x402/compat", (_req, res) => {
    res.json({
      paymentRequiredHeaders: ["PAYMENT-REQUIRED", "X-PAYMENT-REQUIRED", "X-402-PAYMENT-REQUIRED"],
      paymentProofHeaders: ["PAYMENT-SIGNATURE", "X-PAYMENT", "X-402-PAYMENT"],
    });
  });

  app.get("/x402/doctor", (req, res) => {
    const report = analyzeX402({
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([key, value]) => [key, Array.isArray(value) ? value : value ? String(value) : undefined]),
      ),
      body: req.body,
    });
    res.json(report);
  });

  app.post("/x402/doctor", (req, res) => {
    const inputHeaders = req.body && typeof req.body === "object" && "headers" in (req.body as Record<string, unknown>)
      ? (req.body as { headers?: Record<string, string> }).headers
      : undefined;
    const inputBody = req.body && typeof req.body === "object" && "body" in (req.body as Record<string, unknown>)
      ? (req.body as { body?: unknown }).body
      : undefined;

    const report = analyzeX402({
      headers: inputHeaders ?? {},
      body: inputBody,
    });
    res.json(report);
  });

  app.get("/drill/fee-accruals", adminAuth({ secret: config.adminSecret, allowInsecure: config.allowInsecure }), (_req, res) => {
    if (!config.realChainDrill?.enabled) {
      res.status(404).json({ ok: false, error: "real_chain_drill_disabled" });
      return;
    }
    res.json({
      ok: true,
      summary: realChainFeeAccrualSummary(),
      accruals: realChainFeeAccruals,
    });
  });

  app.get("/admin/x402/fee-accruals", adminAuth({ secret: config.adminSecret, allowInsecure: config.allowInsecure }), (_req, res) => {
    res.json({
      ok: true,
      count: feeAccruals.length,
      accruals: feeAccruals,
    });
  });

  app.get("/market/anchoring/status", (_req, res) => {
    const status = context.anchoringQueue?.getStatus();
    res.json({
      enabled: Boolean(context.anchoringQueue),
      anchorProgramId,
      protocolProgramId,
      anchorProgramOk,
      queueDepth: status?.queueDepth ?? 0,
      anchoredCount: status?.anchoredCount ?? 0,
      lastFlushAt: status?.lastFlushAt ?? null,
      lastAnchorSig: status?.lastAnchorSig ?? null,
      lastBucketId: status?.lastBucketId ?? null,
      lastBucketCount: status?.lastBucketCount ?? null,
    });
  });

  app.get("/demo/ping", (_req, res) => {
    res.json({
      ok: true,
      serverTime: now().toISOString(),
      requestId: crypto.randomUUID(),
    });
  });

  app.get("/quote", (req, res) => {
    if (!runtimeGates.quotes) {
      res.status(503).json({
        ok: false,
        error: "quote_gate_disabled",
        message: "Quote creation is disabled by runtime gate config.",
      });
      return;
    }

    if (context.emergencyPause.isPaused("quotePaused")) {
      res.status(503).json({
        ok: false,
        error: "quote_paused",
        message: "Quote creation is paused by emergency controls.",
      });
      return;
    }

    const parsed = quoteQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    if (!enforceGuardSpend(req, res, {
      resource: parsed.data.resource,
      amountAtomic: getTotalAtomicForResource(parsed.data.resource, parsed.data.amountAtomic),
      stage: "quote",
    })) {
      return;
    }

    let builderInput: { builderProfile?: BuilderProfile; builderFee?: BuilderFeeConfig };
    try {
      builderInput = builderFeeFromQuery(parsed.data);
    } catch (error) {
      res.status(422).json({ ok: false, error: "builder_fee_policy_rejected", reasonCode: (error as Error).message });
      return;
    }

    let quote: Quote;
    try {
      quote = issueQuote(parsed.data.resource, parsed.data.amountAtomic, builderInput);
    } catch (error) {
      res.status(422).json({ ok: false, error: "fee_waterfall_rejected", reasonCode: (error as Error).message });
      return;
    }
    const drillAmount = realChainDrillAmountAllowed(quote.totalAtomic);
    if (!drillAmount.ok) {
      res.status(403).json({ ok: false, error: "real_chain_drill_cap_exceeded", message: drillAmount.reason });
      return;
    }
    const betaAmount = publicBetaLiveAmountAllowed(quote.totalAtomic);
    if (!betaAmount.ok) {
      res.status(403).json({ ok: false, error: "public_beta_cap_exceeded", message: betaAmount.reason });
      return;
    }
    res.json(toQuoteResponse(quote, config));
  });

  app.post("/commit", (req, res) => {
    const parsed = commitBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const quote = quotes.get(parsed.data.quoteId);
    if (!quote) {
      res.status(404).json({ error: "quote not found" });
      return;
    }

    if (isExpired(quote.expiresAt, now())) {
      res.status(410).json({ error: "quote expired" });
      return;
    }

    if (!enforceGuardSpend(req, res, {
      resource: quote.resource,
      amountAtomic: quote.totalAtomic,
      stage: "finalize",
    })) {
      return;
    }

    let payerCommitment32B: string;
    try {
      payerCommitment32B = normalizeCommitment32B(parsed.data.payerCommitment32B);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
      return;
    }

    const commitId = crypto.randomUUID();
    const commit: CommitRecord = {
      commitId,
      quoteId: quote.quoteId,
      payerCommitment32B,
      createdAt: now().toISOString(),
      status: "pending",
    };
    commits.set(commitId, commit);

    res.status(201).json({ commitId });
  });

  app.post("/finalize", async (req, res) => {
    if (!runtimeGates.finalize || config.pauseFinalize || context.emergencyPause.isPaused("finalizePaused")) {
      sendX402Error(req, res, new X402Error(X402ErrorCode.X402_PAUSED, {
        message: "Finalize route is paused by server policy.",
        cause: !runtimeGates.finalize
          ? "X402_ENABLE_FINALIZE is disabled."
          : config.pauseFinalize
            ? "PAUSE_FINALIZE is enabled."
            : "Emergency finalize pause is enabled.",
      }));
      return;
    }

    const parsed = finalizeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const commit = commits.get(parsed.data.commitId);
    if (!commit) {
      res.status(404).json({ error: "commit not found" });
      return;
    }

    const quote = quotes.get(commit.quoteId);
    if (!quote) {
      res.status(404).json({ error: "quote for commit not found" });
      return;
    }

    if (isExpired(quote.expiresAt, now())) {
      res.status(410).json({ error: "quote expired" });
      return;
    }

    const drillAmount = realChainDrillAmountAllowed(quote.totalAtomic);
    if (!drillAmount.ok) {
      res.status(403).json({ ok: false, error: "real_chain_drill_cap_exceeded", message: drillAmount.reason });
      return;
    }
    const betaAmount = publicBetaLiveAmountAllowed(quote.totalAtomic);
    if (!betaAmount.ok) {
      res.status(403).json({ ok: false, error: "public_beta_cap_exceeded", message: betaAmount.reason });
      return;
    }

    if (commit.status === "finalized" && commit.receiptId) {
      const existing = receipts.get(commit.receiptId);
      if (existing) {
        res.json({ ok: true, receiptId: existing.payload.receiptId, accessTokenOrResult: { commitId: commit.commitId } });
        return;
      }
    }

    const directSplitRequirements = splitPaymentRequirementsForQuote(quote, config) ?? [];
    const directSplitRequired = directSplitRequirements.length > 0;
    if (directSplitRequired) {
      if (!parsed.data.splitPaymentProofs?.length) {
        sendX402Error(req, res, new X402Error(X402ErrorCode.X402_MISSING_PAYMENT_PROOF, {
          cause: "direct split finalize requires splitPaymentProofs for provider and DNA fee lines",
        }), {
          dialectDetected: "generic",
        });
        return;
      }
    } else if (!parsed.data.paymentProof) {
      res.status(400).json({ error: "Missing or invalid paymentProof" });
      return;
    }

    if (!directSplitRequired && parsed.data.paymentProof && !quote.settlement.includes(parsed.data.paymentProof.settlement)) {
      res.status(400).json({ ok: false, error: `Unsupported settlement mode: ${parsed.data.paymentProof.settlement}` });
      return;
    }

    if (!directSplitRequired && parsed.data.paymentProof?.settlement === "netting" && !config.unsafeUnverifiedNettingEnabled) {
      res.status(422).json({
        ok: false,
        error: "netting_disabled",
        message: "Unsigned netting is disabled. Enable UNSAFE_UNVERIFIED_NETTING_ENABLED only for trusted bilateral settlement.",
      });
      return;
    }

    const drillFinalize = realChainDrillFinalizeAllowed(quote.totalAtomic);
    if (!drillFinalize.ok) {
      res.status(403).json({ ok: false, error: "real_chain_drill_cap_exceeded", message: drillFinalize.reason });
      return;
    }
    const betaFinalize = publicBetaLiveFinalizeAllowed(quote.totalAtomic);
    if (!betaFinalize.ok) {
      res.status(403).json({ ok: false, error: "public_beta_daily_cap_exceeded", message: betaFinalize.reason });
      return;
    }

    const directSplitVerification = directSplitRequired
      ? await verifyDirectSplitProofs(req, res, commit, quote, parsed.data.splitPaymentProofs ?? [])
      : undefined;
    if (directSplitVerification && !directSplitVerification.ok) {
      return;
    }

    const paymentProof = directSplitVerification?.ok
      ? directSplitVerification.primaryPaymentProof
      : parsed.data.paymentProof as PaymentProof;
    const verification = directSplitVerification?.ok
      ? { ok: true, ...directSplitVerification.primaryVerification }
      : await verifyPaymentForQuote(quote, paymentProof);
    if (!verification.ok) {
      commit.status = "failed";
      commits.set(commit.commitId, commit);
      sendX402Error(req, res, new X402Error(verifierErrorCode(verification), {
        cause: verification.error ?? "payment proof rejected",
      }), {
        dialectDetected: "generic",
      });
      return;
    }
    if (!directSplitRequired && paymentProof.settlement === "transfer" && !verification.txSignature) {
      commit.status = "failed";
      commits.set(commit.commitId, commit);
      sendX402Error(req, res, new X402Error(X402ErrorCode.X402_PROOF_INVALID, {
        cause: "verified transfer settlement is missing canonical txSignature",
      }), {
        dialectDetected: "generic",
      });
      return;
    }
    if (!directSplitRequired && paymentProof.settlement === "stream" && !verification.streamId) {
      commit.status = "failed";
      commits.set(commit.commitId, commit);
      sendX402Error(req, res, new X402Error(X402ErrorCode.X402_PROOF_INVALID, {
        cause: "verified stream settlement is missing canonical streamId",
      }), {
        dialectDetected: "generic",
      });
      return;
    }

    if (!directSplitRequired && paymentProof.settlement === "transfer" && verification.txSignature) {
      const globalReplayKey = createGlobalProofReplayKey({
        shopId: CORE_SHOP_ID,
        proofId: verification.txSignature,
        settlement: "transfer",
      });
      if (!replayStore.consume(globalReplayKey, now().getTime())) {
        recordGuardReplay(req, quote.resource, "x402_global_replay_detected");
        sendX402Error(req, res, new X402Error(X402ErrorCode.X402_REPLAY_DETECTED, {
          details: { settlement: paymentProof.settlement },
        }), {
          dialectDetected: "generic",
          missing: [],
        });
        return;
      }

      const replayKey = createReplayKey({
        shopId: CORE_SHOP_ID,
        txSig: verification.txSignature,
        amountAtomic: quote.totalAtomic,
        recipient: quote.recipient,
        mint: quote.mint,
      });
      if (!replayStore.consume(replayKey, now().getTime())) {
        recordGuardReplay(req, quote.resource, "x402_replay_detected");
        sendX402Error(req, res, new X402Error(X402ErrorCode.X402_REPLAY_DETECTED, {
          details: { settlement: paymentProof.settlement },
        }), {
          dialectDetected: "generic",
          missing: [],
        });
        return;
      }
    }
    if (!directSplitRequired && paymentProof.settlement === "stream" && verification.streamId) {
      const globalReplayKey = createGlobalProofReplayKey({
        shopId: CORE_SHOP_ID,
        proofId: verification.streamId,
        settlement: "stream",
      });
      if (!replayStore.consume(globalReplayKey, now().getTime())) {
        recordGuardReplay(req, quote.resource, "x402_global_replay_detected");
        sendX402Error(req, res, new X402Error(X402ErrorCode.X402_REPLAY_DETECTED, {
          details: { settlement: paymentProof.settlement },
        }), {
          dialectDetected: "generic",
          missing: [],
        });
        return;
      }

      const replayKey = createReplayKey({
        shopId: CORE_SHOP_ID,
        txSig: `stream:${verification.streamId}`,
        amountAtomic: quote.totalAtomic,
        recipient: quote.recipient,
        mint: quote.mint,
      });
      if (!replayStore.consume(replayKey, now().getTime())) {
        recordGuardReplay(req, quote.resource, "x402_replay_detected");
        sendX402Error(req, res, new X402Error(X402ErrorCode.X402_REPLAY_DETECTED, {
          details: { settlement: paymentProof.settlement },
        }), {
          dialectDetected: "generic",
          missing: [],
        });
        return;
      }
    }

    if (!directSplitRequired && paymentProof.settlement === "netting") {
      nettingLedger.add({
        payerCommitment32B: commit.payerCommitment32B,
        providerId: quote.recipient,
        amountAtomic: quote.amountAtomic,
        feeAtomic: quote.feeAtomic,
        quoteId: quote.quoteId,
        commitId: commit.commitId,
        createdAtMs: now().getTime(),
      });
    }

    let signedReceipt: SignedReceipt;
    try {
      signedReceipt = buildReceipt(commit, quote, paymentProof, verification, {
        requestId: commit.commitId,
        requestDigest: computeRequestDigest({
          method: "GET",
          path: quote.resource,
        }),
        responseDigest: fulfilledResponseDigest(quote.resource),
        shopId: CORE_SHOP_ID,
        splitPaymentProofs: directSplitVerification?.ok ? directSplitVerification.receiptProofs : undefined,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("PII_FORBIDDEN")) {
        commit.status = "failed";
        commits.set(commit.commitId, commit);
        auditLog.record({
          kind: "RECEIPT_BLOCKED",
          traceId: req.traceId,
          quoteId: quote.quoteId,
          commitId: commit.commitId,
          settlement: paymentProof.settlement,
          amountAtomic: quote.totalAtomic,
          mint: quote.mint,
        });
        res.status(400).json({
          ok: false,
          error: "immutable_record_blocked",
          message: "Immutable receipt/proof payload contains raw personal or secret-like data.",
        });
        return;
      }
      throw error;
    }
    const receiptValid = verifySignedReceipt(signedReceipt);
    guard?.ledger.commitSpend(observeGuardActor(req), quote.totalAtomic, now());
    recordRealChainDrillFinalize(quote.totalAtomic);
    recordPublicBetaLiveFinalize(quote.totalAtomic);
    const feeAccrual = recordRealChainFeeAccrual({
      quote,
      commit,
      receipt: signedReceipt,
      paymentProof,
      verification,
    });
    const canonicalFeeAccruals = quote.feeWaterfallV2
      ? createFeeAccrualRecords(quote.feeWaterfallV2, {
        commitId: commit.commitId,
        receiptId: signedReceipt.payload.receiptId,
        createdAt: now().toISOString(),
      })
      : [];
    if (quote.feeWaterfallV2) {
      assertImmutableRecordSafe("PROOF_RECORD", quote.feeWaterfallV2);
      await feeLedgerStore.recordWaterfall(quote.feeWaterfallV2);
    }
    for (const accrual of canonicalFeeAccruals) {
      assertImmutableRecordSafe("PROOF_RECORD", accrual);
      feeAccruals.push(accrual);
      await feeLedgerStore.recordAccrual(accrual);
    }
    recordGuardReceiptVerification(req, quote.resource, signedReceipt.payload.receiptId, receiptValid, receiptValid ? undefined : "receipt_signature_invalid");
    recordMarketEvent({
      type: "PAYMENT_VERIFIED",
      shopId: CORE_SHOP_ID,
      endpointId: endpointIdForResource(quote.resource),
      capabilityTags: capabilityTagsForResource(quote.resource),
      priceAmount: quote.totalAtomic,
      mint: quote.mint,
      settlementMode: paymentProof.settlement,
      receiptId: signedReceipt.payload.receiptId,
      anchor32: commit.payerCommitment32B,
      buyerCommitment32B: commit.payerCommitment32B,
      anchored: false,
      verificationTier: "FAST",
      receiptValid,
    });

    context.anchoringQueue?.enqueue({
      receiptId: signedReceipt.payload.receiptId,
      anchor32: commit.payerCommitment32B,
      shopId: CORE_SHOP_ID,
      endpointId: endpointIdForResource(quote.resource),
      capabilityTags: capabilityTagsForResource(quote.resource),
      priceAmount: quote.totalAtomic,
      mint: quote.mint,
      settlementMode: paymentProof.settlement,
    });

    commit.status = "finalized";
    commit.settlementMode = paymentProof.settlement;
    commit.receiptId = signedReceipt.payload.receiptId;
    commits.set(commit.commitId, commit);

    auditLog.record({
      kind: "PAYMENT_VERIFIED",
      traceId: req.traceId,
      quoteId: quote.quoteId,
      commitId: commit.commitId,
      receiptId: signedReceipt.payload.receiptId,
      settlement: paymentProof.settlement,
      amountAtomic: quote.totalAtomic,
      mint: quote.mint,
      recipient: quote.recipient,
    });
    auditLog.record({
      kind: "RECEIPT_ISSUED",
      traceId: req.traceId,
      receiptId: signedReceipt.payload.receiptId,
      quoteId: quote.quoteId,
      commitId: commit.commitId,
      settlement: paymentProof.settlement,
      amountAtomic: quote.totalAtomic,
      mint: quote.mint,
    });

    res.json({
      ok: true,
      receiptId: signedReceipt.payload.receiptId,
      feeAccrual: feeAccrual
        ? {
          id: feeAccrual.id,
          status: feeAccrual.status,
          platformFeeAtomic: feeAccrual.platformFeeAtomic,
          platformFeeBps: feeAccrual.platformFeeBps,
          platformRecipient: feeAccrual.platformRecipient,
          collected: feeAccrual.collected,
        }
        : undefined,
      feeAccruals: canonicalFeeAccruals.length > 0
        ? canonicalFeeAccruals.map((item) => ({
          id: item.id,
          feeKind: item.feeKind,
          amount: item.amount,
          recipient: item.recipient,
          status: item.status,
        }))
        : undefined,
      splitPaymentResults: directSplitVerification?.ok
        ? directSplitVerification.receiptProofs?.map((item) => ({
          feeLineId: item.feeLineId,
          kind: item.kind,
          recipient: item.recipient,
          amount: item.amount,
          token: item.token,
          settlement: item.settlement,
          txSignature: item.txSignature,
        }))
        : undefined,
      accessTokenOrResult: {
        commitId: commit.commitId,
        resource: quote.resource,
      },
    });
  });

  app.get("/receipt/:receiptId", (req, res) => {
    const receipt = receipts.get(req.params.receiptId);
    if (!receipt) {
      res.status(404).json({ error: "receipt not found" });
      return;
    }
    res.json(receipt);
  });

  app.get("/anchoring/receipt/:receiptId", (req, res) => {
    if (!context.anchoringQueue) {
      res.status(404).json({ ok: false, error: "anchoring_disabled" });
      return;
    }
    const anchored = context.anchoringQueue.getAnchoredRecord(req.params.receiptId);
    if (!anchored) {
      res.status(404).json({ ok: false, error: "anchor_not_found" });
      return;
    }
    res.json({ ok: true, anchored });
  });

  app.post("/settlements/flush", adminAuth({ secret: config.adminSecret, allowInsecure: config.allowInsecure }), (req, res) => {
    const parsed = flushSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const batches = nettingLedger.flushReady(parsed.data.nowMs ?? now().getTime());
    res.json({ batches });
  });

  app.post("/bundle/:id/run", async (req, res) => {
    if (config.pauseMarket) {
      res.status(503).json({
        ok: false,
        error: "market_paused",
        message: "Bundle execution is paused by server policy (PAUSE_MARKET).",
      });
      return;
    }

    try {
      const result = await market.bundleExecutor.run(req.params.id, req.body ?? {});
      res.json(result);
    } catch (error) {
      res.status(400).json({ ok: false, error: (error as Error).message });
    }
  });

  const auditFixtureRateLimiter = createFixedWindowRateLimiter(120, 60_000);

  function registerAuditFixtureRoute(fixture: { id: string; path: string; title: string }): void {
    app.get(fixture.path, (req, res) => {
      const nowMs = Date.now();
      const requester = req.ip || req.socket.remoteAddress || "unknown";
      if (!auditFixtureRateLimiter(requester, nowMs)) {
        sendX402Error(req, res, new X402Error(X402ErrorCode.X402_RATE_LIMITED, {
          cause: `fixture request limit exceeded for ${requester}`,
        }), {
          dialectDetected: "unknown",
        });
        return;
      }

      const handle = async () => {
        const compat = await tryCompatPayment(req, res, fixture.path);
        if (compat.handled) {
          return true;
        }
        return false;
      };

      const started = Date.now();
      const commitId = req.header("x-dnp-commit-id");
      if (commitId) {
        const commit = commits.get(commitId);
        if (commit && commit.status === "finalized" && commit.receiptId) {
          const quote = quotes.get(commit.quoteId);
          const receipt = receipts.get(commit.receiptId);

          if (quote && receipt && quote.resource === fixture.path) {
            if (claimCommitDelivery(commit, receipt.payload.receiptId)) {
              res.once("finish", () => {
                if ((res.statusCode ?? 200) >= 500) {
                  restoreClaimedCommitDelivery(commit.commitId, receipt.payload.receiptId);
                }
              });
              const anchored = context.anchoringQueue?.isAnchored(receipt.payload.receiptId) ?? false;
              const qualityAccepted = verifySignedReceipt(receipt);
              const responseBody = fulfilledResponseBody(fixture.path);
              recordGuardDelivery(fixture.path, Date.now() - started, 200, receipt.payload.receiptId, qualityAccepted);
              recordMarketEvent({
                type: "REQUEST_FULFILLED",
                shopId: CORE_SHOP_ID,
                endpointId: endpointIdForResource(quote.resource),
                capabilityTags: capabilityTagsForResource(quote.resource),
                priceAmount: quote.totalAtomic,
                mint: quote.mint,
                settlementMode: commit.settlementMode,
                latencyMs: Date.now() - started,
                statusCode: 200,
                receiptId: receipt.payload.receiptId,
                anchor32: commit.payerCommitment32B,
                buyerCommitment32B: commit.payerCommitment32B,
                anchored,
                verificationTier: anchored ? "VERIFIED" : "FAST",
                receiptValid: verifySignedReceipt(receipt),
              });
              res.json({
                ...responseBody,
                verifiable: {
                  receipt: true,
                  anchored,
                },
                receipt,
              });
              return;
            }
          }
        }
      }

      void handle().then((handled) => {
        if (handled) {
          return;
        }

        if (!enforceGuardSpend(req, res, {
          resource: fixture.path,
          amountAtomic: getTotalAtomicForResource(fixture.path),
          stage: "quote",
        })) {
          return;
        }

        const quote = issueQuote(fixture.path);
        const baseUrl = inferBaseUrl(req);
        const paymentRequirements = buildPaymentRequirements(quote, baseUrl, config);
        const canonicalRequired = canonicalRequiredFromQuote(quote, config);
        const encodedRequired = encodeCanonicalRequiredHeader(canonicalRequired);

        res.setHeader("PAYMENT-REQUIRED", encodedRequired);
        res.setHeader("X-PAYMENT-REQUIRED", encodedRequired);
        res.setHeader("X-402-PAYMENT-REQUIRED", encodedRequired);
        res.status(402).json({
          error: "payment_required",
          fixtureId: fixture.id,
          seller_defined: true,
          verifiable: {
            receipt: true,
            anchored: false,
          },
          paymentRequirements,
        });
      }).catch((error) => {
        logError("audit_fixture_handler_failure", { error: String(error) }, { traceId: req.traceId, route: fixture.path });
        sendX402Error(req, res, error);
      });
    });
  }

  if (auditFixturesEnabled) {
    app.get("/audit/fixtures/status", (_req, res) => {
      res.json({
        enabled: true,
        basePath: AUDIT_FIXTURE_BASE_PATH,
        count: AUDIT_FIXTURES.length,
        primitives: AUDIT_FIXTURES.map((fixture) => ({
          id: fixture.id,
          path: fixture.path,
          title: fixture.title,
          seller_defined: true,
          verifiable: {
            receipt: true,
            anchored: "depends_on_anchor_confirmation",
          },
        })),
      });
    });

    for (const fixture of AUDIT_FIXTURES) {
      registerAuditFixtureRoute(fixture);
    }
  }

  app.get("/resource", (req, res) => {
    const handle = async () => {
      const compat = await tryCompatPayment(req, res, "/resource");
      if (compat.handled) {
        return true;
      }
      return false;
    };

    const started = Date.now();
    const commitId = req.header("x-dnp-commit-id");
    if (commitId) {
      const commit = commits.get(commitId);
      if (commit && commit.status === "finalized" && commit.receiptId) {
        const quote = quotes.get(commit.quoteId);
        const receipt = receipts.get(commit.receiptId);

        if (quote && receipt && quote.resource === "/resource") {
          if (claimCommitDelivery(commit, receipt.payload.receiptId)) {
            res.once("finish", () => {
              if ((res.statusCode ?? 200) >= 500) {
                restoreClaimedCommitDelivery(commit.commitId, receipt.payload.receiptId);
              }
            });
            const anchored = context.anchoringQueue?.isAnchored(receipt.payload.receiptId) ?? false;
            const qualityAccepted = verifySignedReceipt(receipt);
            const responseBody = fulfilledResponseBody("/resource");
            recordGuardDelivery("/resource", Date.now() - started, 200, receipt.payload.receiptId, qualityAccepted);
            recordMarketEvent({
              type: "REQUEST_FULFILLED",
              shopId: CORE_SHOP_ID,
              endpointId: endpointIdForResource(quote.resource),
              capabilityTags: capabilityTagsForResource(quote.resource),
              priceAmount: quote.totalAtomic,
              mint: quote.mint,
              settlementMode: commit.settlementMode,
              latencyMs: Date.now() - started,
              statusCode: 200,
              receiptId: receipt.payload.receiptId,
              anchor32: commit.payerCommitment32B,
              buyerCommitment32B: commit.payerCommitment32B,
              anchored,
              verificationTier: anchored ? "VERIFIED" : "FAST",
              receiptValid: verifySignedReceipt(receipt),
            });
            res.json({
              ...responseBody,
              receipt,
            });
            return;
          }
        }
      }
    }

    void handle().then((handled) => {
      if (handled) {
        return;
      }
      if (!enforceGuardSpend(req, res, {
        resource: "/resource",
        amountAtomic: getTotalAtomicForResource("/resource"),
        stage: "quote",
      })) {
        return;
      }
      const quote = issueQuote("/resource");
      const baseUrl = inferBaseUrl(req);
      const paymentRequirements = buildPaymentRequirements(quote, baseUrl, config);
      const canonicalRequired = canonicalRequiredFromQuote(quote, config);
      const encodedRequired = encodeCanonicalRequiredHeader(canonicalRequired);

      res.setHeader("PAYMENT-REQUIRED", encodedRequired);
      res.setHeader("X-PAYMENT-REQUIRED", encodedRequired);
      res.setHeader("X-402-PAYMENT-REQUIRED", encodedRequired);
      res.status(402).json({
        error: "payment_required",
        paymentRequirements,
      });
    }).catch((error) => {
      logError("resource_handler_failure", { error: String(error) }, { traceId: req.traceId, route: "/resource" });
      sendX402Error(req, res, error);
    });
  });

  app.get("/inference", (req, res) => {
    const handle = async () => {
      const compat = await tryCompatPayment(req, res, "/inference");
      if (compat.handled) {
        return true;
      }
      return false;
    };

    const started = Date.now();
    const commitId = req.header("x-dnp-commit-id");
    if (commitId) {
      const commit = commits.get(commitId);
      if (commit && commit.status === "finalized" && commit.receiptId) {
        const quote = quotes.get(commit.quoteId);
        const receipt = receipts.get(commit.receiptId);
        if (quote && receipt && quote.resource === "/inference") {
          if (claimCommitDelivery(commit, receipt.payload.receiptId)) {
            res.once("finish", () => {
              if ((res.statusCode ?? 200) >= 500) {
                restoreClaimedCommitDelivery(commit.commitId, receipt.payload.receiptId);
              }
            });
            const anchored = context.anchoringQueue?.isAnchored(receipt.payload.receiptId) ?? false;
            const qualityAccepted = verifySignedReceipt(receipt);
            const responseBody = fulfilledResponseBody("/inference");
            recordGuardDelivery("/inference", Date.now() - started, 200, receipt.payload.receiptId, qualityAccepted);
            recordMarketEvent({
              type: "REQUEST_FULFILLED",
              shopId: CORE_SHOP_ID,
              endpointId: endpointIdForResource(quote.resource),
              capabilityTags: capabilityTagsForResource(quote.resource),
              priceAmount: quote.totalAtomic,
              mint: quote.mint,
              settlementMode: commit.settlementMode,
              latencyMs: Date.now() - started,
              statusCode: 200,
              receiptId: receipt.payload.receiptId,
              anchor32: commit.payerCommitment32B,
              buyerCommitment32B: commit.payerCommitment32B,
              anchored,
              verificationTier: anchored ? "VERIFIED" : "FAST",
              receiptValid: verifySignedReceipt(receipt),
            });
            res.json({
              ...responseBody,
              receipt,
            });
            return;
          }
        }
      }
    }

    void handle().then((handled) => {
      if (handled) {
        return;
      }
      if (!enforceGuardSpend(req, res, {
        resource: "/inference",
        amountAtomic: getTotalAtomicForResource("/inference"),
        stage: "quote",
      })) {
        return;
      }
      const quote = issueQuote("/inference");
      const baseUrl = inferBaseUrl(req);
      const paymentRequirements = buildPaymentRequirements(quote, baseUrl, config);
      const canonicalRequired = canonicalRequiredFromQuote(quote, config);
      const encodedRequired = encodeCanonicalRequiredHeader(canonicalRequired);

      res.setHeader("PAYMENT-REQUIRED", encodedRequired);
      res.setHeader("X-PAYMENT-REQUIRED", encodedRequired);
      res.setHeader("X-402-PAYMENT-REQUIRED", encodedRequired);
      res.status(402).json({
        error: "payment_required",
        paymentRequirements,
      });
    }).catch((error) => {
      logError("inference_handler_failure", { error: String(error) }, { traceId: req.traceId, route: "/inference" });
      sendX402Error(req, res, error);
    });
  });

  app.get("/stream-access", (req, res) => {
    const handle = async () => {
      const compat = await tryCompatPayment(req, res, "/stream-access");
      if (compat.handled) {
        return true;
      }
      return false;
    };

    const started = Date.now();
    const commitId = req.header("x-dnp-commit-id");
    if (commitId) {
      const commit = commits.get(commitId);
      if (commit && commit.status === "finalized" && commit.receiptId) {
        const quote = quotes.get(commit.quoteId);
        const receipt = receipts.get(commit.receiptId);
        if (quote && receipt && quote.resource === "/stream-access") {
          if (claimCommitDelivery(commit, receipt.payload.receiptId)) {
            res.once("finish", () => {
              if ((res.statusCode ?? 200) >= 500) {
                restoreClaimedCommitDelivery(commit.commitId, receipt.payload.receiptId);
              }
            });
            const anchored = context.anchoringQueue?.isAnchored(receipt.payload.receiptId) ?? false;
            const qualityAccepted = verifySignedReceipt(receipt);
            const responseBody = fulfilledResponseBody("/stream-access");
            recordGuardDelivery("/stream-access", Date.now() - started, 200, receipt.payload.receiptId, qualityAccepted);
            recordMarketEvent({
              type: "REQUEST_FULFILLED",
              shopId: CORE_SHOP_ID,
              endpointId: endpointIdForResource(quote.resource),
              capabilityTags: capabilityTagsForResource(quote.resource),
              priceAmount: quote.totalAtomic,
              mint: quote.mint,
              settlementMode: commit.settlementMode,
              latencyMs: Date.now() - started,
              statusCode: 200,
              receiptId: receipt.payload.receiptId,
              anchor32: commit.payerCommitment32B,
              buyerCommitment32B: commit.payerCommitment32B,
              anchored,
              verificationTier: anchored ? "VERIFIED" : "FAST",
              receiptValid: verifySignedReceipt(receipt),
            });
            res.json({
              ...responseBody,
              receipt,
            });
            return;
          }
        }
      }
    }

    void handle().then((handled) => {
      if (handled) {
        return;
      }
      if (!enforceGuardSpend(req, res, {
        resource: "/stream-access",
        amountAtomic: getTotalAtomicForResource("/stream-access"),
        stage: "quote",
      })) {
        return;
      }
      const quote = issueQuote("/stream-access");
      const baseUrl = inferBaseUrl(req);
      const paymentRequirements = buildPaymentRequirements(quote, baseUrl, config);
      const canonicalRequired = canonicalRequiredFromQuote(quote, config);
      const encodedRequired = encodeCanonicalRequiredHeader(canonicalRequired);

      res.setHeader("PAYMENT-REQUIRED", encodedRequired);
      res.setHeader("X-PAYMENT-REQUIRED", encodedRequired);
      res.setHeader("X-402-PAYMENT-REQUIRED", encodedRequired);
      res.status(402).json({
        error: "payment_required",
        paymentRequirements,
      });
    }).catch((error) => {
      logError("stream_access_handler_failure", { error: String(error) }, { traceId: req.traceId, route: "/stream-access" });
      sendX402Error(req, res, error);
    });
  });

  return { app, context };
}

export async function startServer(config: X402Config = loadConfig()): Promise<void> {
  assertMainnetReadiness(config);
  const { app, context } = createX402App(config);
  await new Promise<void>((resolve) => {
    app.listen(config.port, () => {
      // eslint-disable-next-line no-console
      console.log(`x402 server listening on http://localhost:${config.port}`);
      context.auditLog.record({ kind: "SERVER_STARTED", meta: { port: config.port, cluster: config.cluster } });
      resolve();
    });
  });
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (entryPath === modulePath) {
  startServer().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exitCode = 1;
  });
}
