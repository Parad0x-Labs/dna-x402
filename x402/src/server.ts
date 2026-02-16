import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { Connection } from "@solana/web3.js";
import { X402Config, loadConfig } from "./config.js";
import { calculateFeeAtomic, calculateTotalAtomic, parseAtomic, shouldUseNetting, toAtomicString } from "./feePolicy.js";
import { NettingLedger } from "./nettingLedger.js";
import { PaymentVerifier, SolanaPaymentVerifier } from "./paymentVerifier.js";
import { normalizeCommitment32B, ReceiptSigner, verifySignedReceipt } from "./receipts.js";
import { createMarketRouter, MarketContext } from "./market/server.js";
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
}

export interface X402AppContext {
  quotes: Map<string, Quote>;
  commits: Map<string, CommitRecord>;
  receipts: Map<string, SignedReceipt>;
  nettingLedger: NettingLedger;
  market: MarketContext;
  config: X402Config;
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
  if (shouldUseNetting(config.feePolicy, total) && quote.settlement.includes("netting")) {
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

export function createX402App(config: X402Config = loadConfig(), deps: CreateAppDeps = {}): {
  app: express.Express;
  context: X402AppContext;
} {
  const app = express();
  const now = deps.now ?? (() => new Date());

  const connection = new Connection(config.solanaRpcUrl, "confirmed");
  const paymentVerifier = deps.paymentVerifier ?? new SolanaPaymentVerifier(connection);
  const receiptSigner = deps.receiptSigner ?? (config.receiptSigningSecret
    ? ReceiptSigner.fromBase58Secret(config.receiptSigningSecret)
    : ReceiptSigner.generate());
  const nettingLedger = deps.nettingLedger ?? new NettingLedger({
    settleThresholdAtomic: config.nettingThresholdAtomic,
    settleIntervalMs: config.nettingIntervalMs,
    feeAccrualThresholdAtomic: config.feePolicy.accrueThresholdAtomic,
  });
  const { router: marketRouter, context: market } = createMarketRouter({
    now,
    signer: receiptSigner,
    pauseMarket: config.pauseMarket,
    pauseOrders: config.pauseOrders,
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
    config,
  };

  function recordMarketEvent(event: Parameters<MarketContext["recordEvent"]>[0]): void {
    try {
      market.recordEvent(event);
    } catch {
      // Ignore analytics failures to keep payment path hot.
    }
  }

  function getAmountForResource(resource: string, explicitAtomic?: string): bigint {
    if (explicitAtomic) {
      return parseAtomic(explicitAtomic);
    }
    return DEFAULT_RESOURCE_PRICING[resource] ?? DEFAULT_RESOURCE_PRICING["/resource"];
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
      settlement: ["transfer", "stream", "netting"],
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

  function buildReceipt(commit: CommitRecord, quote: Quote, paymentProof: PaymentProof, verification: { settledOnchain: boolean; txSignature?: string; streamId?: string }): SignedReceipt {
    const payload: ReceiptPayload = {
      receiptId: crypto.randomUUID(),
      quoteId: quote.quoteId,
      commitId: commit.commitId,
      resource: quote.resource,
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

  app.use(cors());
  app.use(express.json());
  app.use("/market", marketRouter);

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
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
        eventsIndexed: market.storage.all().length,
        paused: market.pauseMarket,
        ordersPaused: market.pauseOrders,
      },
      pauseFlags: {
        finalize: config.pauseFinalize,
      },
      signer: receiptSigner.signerPublicKey,
    });
  });

  app.get("/quote", (req, res) => {
    const parsed = quoteQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
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
      res.status(503).json({
        ok: false,
        error: "finalize_paused",
        message: "Finalize route is paused by server policy (PAUSE_FINALIZE).",
      });
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

    if (commit.status === "finalized" && commit.receiptId) {
      const existing = receipts.get(commit.receiptId);
      if (existing) {
        res.json({ ok: true, receiptId: existing.payload.receiptId, accessTokenOrResult: { commitId: commit.commitId } });
        return;
      }
    }

    const paymentProof = parsed.data.paymentProof as PaymentProof;
    const verification = await paymentVerifier.verify(quote, paymentProof);
    if (!verification.ok) {
      commit.status = "failed";
      commits.set(commit.commitId, commit);
      res.status(400).json({ ok: false, error: verification.error ?? "payment proof rejected" });
      return;
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

    const signedReceipt = buildReceipt(commit, quote, paymentProof, verification);
    const receiptValid = verifySignedReceipt(signedReceipt);
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
      anchored: false,
      verificationTier: "FAST",
      receiptValid,
    });

    commit.status = "finalized";
    commit.settlementMode = paymentProof.settlement;
    commit.receiptId = signedReceipt.payload.receiptId;
    commits.set(commit.commitId, commit);

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

  app.get("/resource", (req, res) => {
    const started = Date.now();
    const commitId = req.header("x-dnp-commit-id");
    if (commitId) {
      const commit = commits.get(commitId);
      if (commit && commit.status === "finalized" && commit.receiptId) {
        const quote = quotes.get(commit.quoteId);
        const receipt = receipts.get(commit.receiptId);

        if (quote && receipt && quote.resource === "/resource") {
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
            anchored: false,
            verificationTier: "FAST",
            receiptValid: verifySignedReceipt(receipt),
          });
          res.json({
            ok: true,
            data: "resource payload",
            receipt,
          });
          return;
        }
      }
    }

    const quote = issueQuote("/resource");
    const baseUrl = inferBaseUrl(req);
    const paymentRequirements = buildPaymentRequirements(quote, baseUrl, config);

    res.status(402).json({
      error: "payment_required",
      paymentRequirements,
    });
  });

  app.get("/inference", (req, res) => {
    const started = Date.now();
    const commitId = req.header("x-dnp-commit-id");
    if (commitId) {
      const commit = commits.get(commitId);
      if (commit && commit.status === "finalized" && commit.receiptId) {
        const quote = quotes.get(commit.quoteId);
        const receipt = receipts.get(commit.receiptId);
        if (quote && receipt && quote.resource === "/inference") {
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
            anchored: false,
            verificationTier: "FAST",
            receiptValid: verifySignedReceipt(receipt),
          });
          res.json({
            ok: true,
            output: "inference result",
            receipt,
          });
          return;
        }
      }
    }

    const quote = issueQuote("/inference");
    const baseUrl = inferBaseUrl(req);
    res.status(402).json({
      error: "payment_required",
      paymentRequirements: buildPaymentRequirements(quote, baseUrl, config),
    });
  });

  return { app, context };
}

export async function startServer(config: X402Config = loadConfig()): Promise<void> {
  const { app } = createX402App(config);
  await new Promise<void>((resolve) => {
    app.listen(config.port, () => {
      // eslint-disable-next-line no-console
      console.log(`x402 server listening on http://localhost:${config.port}`);
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
