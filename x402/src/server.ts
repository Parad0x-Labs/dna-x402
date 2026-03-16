import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { Connection } from "@solana/web3.js";
import { X402Config, X402GuardConfig, loadConfig } from "./config.js";
import { calculateFeeAtomic, calculateTotalAtomic, parseAtomic, shouldUseNetting, toAtomicString } from "./feePolicy.js";
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
import { createAdminRouter } from "./admin/router.js";
import { createDnaGuard, DnaGuardController } from "./sdk/guard.js";
import { createFileBackedDnaGuardLedger } from "./guard/storage.js";
import {
  CommitRecord,
  PaymentAccept,
  PaymentProof,
  PaymentRequirements,
  Quote,
  QuoteResponse,
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
}

export interface X402AppContext {
  quotes: Map<string, Quote>;
  commits: Map<string, CommitRecord>;
  receipts: Map<string, SignedReceipt>;
  nettingLedger: NettingLedger;
  market: MarketContext;
  anchoringQueue?: AnchoringQueue;
  replayStore: ReplayStore;
  config: X402Config;
  auditLog: AuditLogger;
  webhookService: WebhookService;
  guard?: DnaGuardController;
}

const quoteQuerySchema = z.object({
  resource: z.string().min(1).default("/resource"),
  amountAtomic: z.string().regex(/^\d+$/).optional(),
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

const finalizeBodySchema = z.object({
  commitId: z.string().uuid(),
  paymentProof: paymentProofSchema,
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

function toQuoteResponse(quote: Quote): QuoteResponse {
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

function buildPaymentRequirements(quote: Quote, baseUrl: string, config: X402Config): PaymentRequirements {
  return {
    version: "x402-dnp-v1",
    quote: toQuoteResponse(quote),
    accepts: buildAcceptModes(quote, config),
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

export function createX402App(config: X402Config = loadConfig(), deps: CreateAppDeps = {}): {
  app: express.Express;
  context: X402AppContext;
} {
  const app = express();
  const now = deps.now ?? (() => new Date());
  const guardConfig = resolveGuardConfig(config);

  const connection = new Connection(config.solanaRpcUrl, "confirmed");
  const paymentVerifier = deps.paymentVerifier ?? new SolanaPaymentVerifier(connection, {
    allowUnverifiedNetting: config.unsafeUnverifiedNettingEnabled,
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
    stdout: true,
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
  const { router: marketRouter, context: market } = createMarketRouter({
    now,
    signer: receiptSigner,
    pauseMarket: config.pauseMarket,
    pauseOrders: config.pauseOrders,
    disabledShops: config.disabledShops,
    autoDisableReportThreshold: config.autoDisableReportThreshold,
  });

  const quotes = new Map<string, Quote>();
  const commits = new Map<string, CommitRecord>();
  const receipts = new Map<string, SignedReceipt>();

  const context: X402AppContext = {
    quotes,
    commits,
    receipts,
    nettingLedger,
    market,
    anchoringQueue: undefined,
    replayStore,
    config,
    auditLog,
    webhookService,
    guard,
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
    const actor = input.req ? guardActorFromRequest(input.req) : undefined;
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
        guardActorFromRequest(req),
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

  function getTotalAtomicForResource(resource: string, explicitAtomic?: string): string {
    const amountAtomic = getAmountForResource(resource, explicitAtomic);
    return toAtomicString(calculateTotalAtomic(config.feePolicy, amountAtomic));
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

  function issueQuote(resource: string, amountAtomicOverride?: string): Quote {
    const issuedAt = now();
    const quoteId = crypto.randomUUID();
    const amountAtomic = getAmountForResource(resource, amountAtomicOverride);
    const feeAtomic = calculateFeeAtomic(config.feePolicy, amountAtomic);
    const totalAtomic = calculateTotalAtomic(config.feePolicy, amountAtomic);
    const expiresAt = new Date(issuedAt.getTime() + config.quoteTtlSeconds * 1000).toISOString();
    const memoHash = hashHex(`${quoteId}:${resource}:${toAtomicString(totalAtomic)}:${expiresAt}`);

    const quote: Quote = {
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
    binding: { requestId: string; requestDigest: string; responseDigest: string; shopId?: string },
  ): SignedReceipt {
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
      createdAt: now().toISOString(),
    };

    const signed = receiptSigner.sign(payload);
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

    if (paymentProof.settlement === "transfer" && verification.txSignature) {
      const key = createReplayKey({
        shopId: CORE_SHOP_ID,
        txSig: verification.txSignature,
        amountAtomic: quote.totalAtomic,
        recipient: quote.recipient,
        mint: quote.mint,
      });
      if (!replayStore.consume(key, now().getTime())) {
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
      body: req.body,
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
    guard?.ledger.commitSpend(guardActorFromRequest(req), quote.totalAtomic, now());
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
  app.use(requireHttpsMiddleware({ allowInsecure: config.allowInsecure ?? true }));
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

    const quote = issueQuote(parsed.data.resource, parsed.data.amountAtomic);
    res.json(toQuoteResponse(quote));
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
    if (config.pauseFinalize) {
      sendX402Error(req, res, new X402Error(X402ErrorCode.X402_PAUSED, {
        message: "Finalize route is paused by server policy.",
        cause: "PAUSE_FINALIZE is enabled.",
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

    if (!quote.settlement.includes(parsed.data.paymentProof.settlement)) {
      res.status(400).json({ ok: false, error: `Unsupported settlement mode: ${parsed.data.paymentProof.settlement}` });
      return;
    }

    if (parsed.data.paymentProof.settlement === "netting" && !config.unsafeUnverifiedNettingEnabled) {
      res.status(422).json({
        ok: false,
        error: "netting_disabled",
        message: "Unsigned netting is disabled. Enable UNSAFE_UNVERIFIED_NETTING_ENABLED only for trusted bilateral settlement.",
      });
      return;
    }

    if (commit.status === "finalized" && commit.receiptId) {
      const existing = receipts.get(commit.receiptId);
      if (existing) {
        res.json({ ok: true, receiptId: existing.payload.receiptId, accessTokenOrResult: { commitId: commit.commitId } });
        return;
      }
    }

    const paymentProof = parsed.data.paymentProof as PaymentProof;
    const verification = await verifyPaymentForQuote(quote, paymentProof);
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
    if (paymentProof.settlement === "transfer" && !verification.txSignature) {
      commit.status = "failed";
      commits.set(commit.commitId, commit);
      sendX402Error(req, res, new X402Error(X402ErrorCode.X402_PROOF_INVALID, {
        cause: "verified transfer settlement is missing canonical txSignature",
      }), {
        dialectDetected: "generic",
      });
      return;
    }
    if (paymentProof.settlement === "stream" && !verification.streamId) {
      commit.status = "failed";
      commits.set(commit.commitId, commit);
      sendX402Error(req, res, new X402Error(X402ErrorCode.X402_PROOF_INVALID, {
        cause: "verified stream settlement is missing canonical streamId",
      }), {
        dialectDetected: "generic",
      });
      return;
    }

    if (paymentProof.settlement === "transfer" && verification.txSignature) {
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
    if (paymentProof.settlement === "stream" && verification.streamId) {
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

    const quoteAtomic = parseAtomic(quote.totalAtomic);
    if (paymentProof.settlement === "netting" || shouldUseNetting(config.feePolicy, quoteAtomic)) {
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

    const signedReceipt = buildReceipt(commit, quote, paymentProof, verification, {
      requestId: commit.commitId,
      requestDigest: computeRequestDigest({
        method: "GET",
        path: quote.resource,
      }),
      responseDigest: fulfilledResponseDigest(quote.resource),
      shopId: CORE_SHOP_ID,
    });
    const receiptValid = verifySignedReceipt(signedReceipt);
    guard?.ledger.commitSpend(guardActorFromRequest(req), quote.totalAtomic, now());
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

  app.post("/settlements/flush", (req, res) => {
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

  return { app, context };
}

export async function startServer(config: X402Config = loadConfig()): Promise<void> {
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
