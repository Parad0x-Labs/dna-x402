/**
 * DNA x402 — Self-Contained Seller SDK
 *
 * One function to turn any Express app into a payment-accepting API.
 * Handles quotes, commits, finalization, and receipts internally.
 * No separate DNA server needed.
 *
 * Warning: this is still a DX scaffold. It now verifies transfer proofs through the local
 * payment verifier, but advanced policy/replay/market controls still live in the full server.
 *
 * Usage:
 *   import express from "express";
 *   import { dnaSeller, dnaPrice } from "dna-x402/seller";
 *
 *   const app = express();
 *   const pay = dnaSeller(app, { recipient: "YOUR_SOLANA_WALLET" });
 *
 *   app.get("/api/inference", dnaPrice("5000"), (req, res) => {
 *     res.json({ result: "your output" });
 *   });
 *
 *   app.listen(3000);
 */
import * as crypto from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { PaymentVerifier } from "../paymentVerifier.js";
import { computeRequestDigest, computeResponseDigest, ReceiptSigner } from "../receipts.js";
import { PaymentAccept, PaymentProof, SignedReceipt } from "../types.js";
import {
  createPaymentVerifier,
  defaultUsdcMintForNetwork,
  inferPaymentNetwork,
  SupportedNetwork,
  verificationFailureStatus,
} from "./paymentSupport.js";

export interface DnaSellerOptions {
  recipient: string;
  mint?: string;
  feeBps?: number;
  quoteTtlSeconds?: number;
  settlement?: Array<"transfer" | "netting">;
  dnaServerUrl?: string;
  network?: SupportedNetwork;
  solanaRpcUrl?: string;
  paymentVerifier?: PaymentVerifier;
  maxTransferProofAgeSeconds?: number;
  unsafeUnverifiedNettingEnabled?: boolean;
  receiptSigner?: ReceiptSigner;
}

interface QuoteRecord {
  quoteId: string;
  amount: string;
  feeAtomic: string;
  totalAtomic: string;
  mint: string;
  recipient: string;
  expiresAt: string;
  settlement: string[];
  memoHash: string;
  resource: string;
  network: PaymentAccept["network"];
}

interface CommitRecord {
  commitId: string;
  quoteId: string;
  payerCommitment: string;
  createdAt: string;
  finalized: boolean;
  receiptId?: string;
}

interface ReceiptRecord {
  signedReceipt: SignedReceipt;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashHex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * Initialize DNA payment handling on an Express app.
 * Mounts /commit, /finalize, /receipt/:id routes automatically.
 */
export function dnaSeller(app: Express, options: DnaSellerOptions) {
  const quotes = new Map<string, QuoteRecord>();
  const commits = new Map<string, CommitRecord>();
  const receipts = new Map<string, ReceiptRecord>();
  const paidCommits = new Set<string>();

  const network = inferPaymentNetwork(options.network, options.solanaRpcUrl);
  const mint = options.mint ?? defaultUsdcMintForNetwork(options.network, options.solanaRpcUrl);
  const feeBps = options.feeBps ?? 0;
  const ttl = options.quoteTtlSeconds ?? 300;
  const settlement = options.settlement ?? ["transfer"];
  const receiptSigner = options.receiptSigner ?? ReceiptSigner.generate();
  const paymentVerifier = createPaymentVerifier({
    rpcUrl: options.solanaRpcUrl,
    maxTransferProofAgeSeconds: options.maxTransferProofAgeSeconds,
    allowUnverifiedNetting: options.unsafeUnverifiedNettingEnabled,
    paymentVerifier: options.paymentVerifier,
  });

  function expireOld() {
    const now = Date.now();
    quotes.forEach((q, id) => {
      if (new Date(q.expiresAt).getTime() < now) quotes.delete(id);
    });
  }

  // POST /commit — lock a quote
  app.post("/commit", (req: Request, res: Response) => {
    const { quoteId, payerCommitment32B } = req.body ?? {};
    if (!quoteId || !payerCommitment32B) {
      res.status(400).json({ error: "Missing quoteId or payerCommitment32B" });
      return;
    }

    expireOld();
    const quote = quotes.get(quoteId);
    if (!quote) {
      res.status(404).json({ error: "Quote not found or expired" });
      return;
    }

    if (new Date(quote.expiresAt).getTime() < Date.now()) {
      quotes.delete(quoteId);
      res.status(410).json({ error: "Quote expired" });
      return;
    }

    const commitId = crypto.randomUUID();
    commits.set(commitId, {
      commitId,
      quoteId,
      payerCommitment: payerCommitment32B,
      createdAt: new Date().toISOString(),
      finalized: false,
    });

    res.status(201).json({ commitId, quoteId, expiresAt: quote.expiresAt });
  });

  // POST /finalize — submit payment proof
  app.post("/finalize", async (req: Request, res: Response) => {
    const { commitId, paymentProof } = req.body ?? {};
    if (!commitId) {
      res.status(400).json({ error: "Missing commitId" });
      return;
    }

    const commit = commits.get(commitId);
    if (!commit) {
      res.status(404).json({ error: "Commit not found" });
      return;
    }

    if (commit.finalized) {
      res.status(409).json({ error: "Already finalized", receiptId: commit.receiptId });
      return;
    }

    const quote = quotes.get(commit.quoteId);
    if (!quote) {
      res.status(410).json({ error: "Quote expired" });
      return;
    }

    const proof = paymentProof as PaymentProof | undefined;
    if (!proof || (proof.settlement !== "transfer" && proof.settlement !== "netting")) {
      res.status(400).json({ error: "Missing or invalid paymentProof" });
      return;
    }

    const settlementMode = proof.settlement;
    if (!quote.settlement.includes(settlementMode)) {
      res.status(400).json({ error: `Unsupported settlement mode: ${settlementMode}` });
      return;
    }

    const verification = await paymentVerifier.verify({
      quoteId: quote.quoteId,
      resource: quote.resource,
      amountAtomic: quote.amount,
      feeAtomic: quote.feeAtomic,
      totalAtomic: quote.totalAtomic,
      mint: quote.mint,
      recipient: quote.recipient,
      expiresAt: quote.expiresAt,
      settlement: quote.settlement as Array<"transfer" | "stream" | "netting">,
      memoHash: quote.memoHash,
    }, proof);

    if (!verification.ok) {
      res.status(verificationFailureStatus(verification)).json({
        ok: false,
        error: {
          code: verification.errorCode ?? "PAYMENT_INVALID",
          message: verification.error ?? "Payment verification failed",
          retryable: verification.retryable ?? false,
        },
      });
      return;
    }

    const receiptId = crypto.randomUUID();
    const finalizeResponse = { ok: true, receiptId, commitId, settlement: settlementMode };
    const signedReceipt = receiptSigner.sign({
      receiptId,
      quoteId: commit.quoteId,
      commitId,
      resource: quote.resource,
      requestId: commitId,
      requestDigest: computeRequestDigest({ method: req.method, path: req.path, body: req.body }),
      responseDigest: computeResponseDigest({ status: 200, body: finalizeResponse }),
      shopId: "self",
      payerCommitment32B: commit.payerCommitment,
      recipient: quote.recipient,
      mint: quote.mint,
      amountAtomic: quote.amount,
      feeAtomic: quote.feeAtomic,
      totalAtomic: quote.totalAtomic,
      settlement: settlementMode,
      settledOnchain: verification.settledOnchain,
      txSignature: verification.txSignature,
      createdAt: new Date().toISOString(),
    });
    const receipt: ReceiptRecord = { signedReceipt };

    receipts.set(receiptId, receipt);
    commit.finalized = true;
    commit.receiptId = receiptId;
    paidCommits.add(commitId);

    res.json(finalizeResponse);
  });

  // GET /receipt/:id
  app.get("/receipt/:id", (req: Request, res: Response) => {
    const receipt = receipts.get(req.params.id as string);
    if (!receipt) {
      res.status(404).json({ error: "Receipt not found" });
      return;
    }
    res.json(receipt.signedReceipt);
  });

  // GET /health
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      mode: "dna-seller-sdk",
      recipient: options.recipient,
      mint,
      network,
      receiptSigner: receiptSigner.signerPublicKey,
      settlement,
      quotes: quotes.size,
      receipts: receipts.size,
    });
  });

  /**
   * Returns the internal state for checking paid commits.
   * Used by dnaPrice middleware.
   */
  return {
    quotes,
    commits,
    receipts,
    paidCommits,
    issueDeliveryReceipt(
      commitId: string,
      req: Request,
      responseBody: Record<string, unknown>,
      statusCode = 200,
    ): SignedReceipt | undefined {
      const commit = commits.get(commitId);
      if (!commit) {
        return undefined;
      }
      const quote = quotes.get(commit.quoteId);
      const paymentReceipt = commit.receiptId ? receipts.get(commit.receiptId) : undefined;
      if (!quote || !paymentReceipt) {
        return undefined;
      }

      const signedReceipt = receiptSigner.sign({
        receiptId: crypto.randomUUID(),
        quoteId: commit.quoteId,
        commitId,
        resource: quote.resource,
        requestId: commitId,
        requestDigest: computeRequestDigest({
          method: req.method,
          path: req.path,
          body: req.body,
        }),
        responseDigest: computeResponseDigest({
          status: statusCode,
          body: responseBody,
        }),
        shopId: "self",
        payerCommitment32B: commit.payerCommitment,
        recipient: quote.recipient,
        mint: quote.mint,
        amountAtomic: quote.amount,
        feeAtomic: quote.feeAtomic,
        totalAtomic: quote.totalAtomic,
        settlement: paymentReceipt.signedReceipt.payload.settlement,
        settledOnchain: paymentReceipt.signedReceipt.payload.settledOnchain,
        txSignature: paymentReceipt.signedReceipt.payload.txSignature,
        createdAt: new Date().toISOString(),
      });

      receipts.set(signedReceipt.payload.receiptId, { signedReceipt });
      return signedReceipt;
    },

    /**
     * Create a quote for a resource at a given price.
     */
    createQuote(resource: string, priceAtomic: string, baseUrl: string): QuoteRecord {
      expireOld();
      const quoteId = crypto.randomUUID();
      const feeAtomic = feeBps > 0
        ? String(Math.ceil((Number(priceAtomic) * feeBps) / 10000))
        : "0";
      const totalAtomic = String(Number(priceAtomic) + Number(feeAtomic));
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
      const memoHash = hashHex(`${quoteId}:${resource}:${priceAtomic}:${expiresAt}`);

      const quote: QuoteRecord = {
        quoteId,
        amount: priceAtomic,
        feeAtomic,
        totalAtomic,
        mint,
        recipient: options.recipient,
        expiresAt,
        settlement,
        memoHash,
        resource,
        network,
      };
      quotes.set(quoteId, quote);
      return quote;
    },
  };
}

/**
 * Price gate middleware — use after calling dnaSeller().
 *
 * Usage:
 *   const pay = dnaSeller(app, { recipient: "..." });
 *   app.get("/api/inference", dnaPrice("5000", pay), handler);
 */
export function dnaPrice(
  priceAtomic: string,
  seller: ReturnType<typeof dnaSeller>,
) {
  return function priceMiddleware(req: Request, res: Response, next: NextFunction): void {
    // Check if already paid
    const commitId = req.header("x-dnp-commit-id");
    if (commitId && seller.paidCommits.has(commitId)) {
      seller.paidCommits.delete(commitId);
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (!isJsonRecord(body)) {
          return originalJson(body);
        }
        const deliveryReceipt = seller.issueDeliveryReceipt(commitId, req, body, res.statusCode || 200);
        return originalJson(deliveryReceipt ? { ...body, receipt: deliveryReceipt } : body);
      }) as typeof res.json;
      next();
      return;
    }

    // Issue quote
    const host = req.get("host") ?? "localhost";
    const baseUrl = `${req.protocol}://${host}`;
    const quote = seller.createQuote(req.path, priceAtomic, baseUrl);

    res.status(402).json({
      error: "payment_required",
      paymentRequirements: {
        version: "x402-dnp-v1",
        quote: {
          quoteId: quote.quoteId,
          amount: quote.amount,
          feeAtomic: quote.feeAtomic,
          totalAtomic: quote.totalAtomic,
          mint: quote.mint,
          recipient: quote.recipient,
          expiresAt: quote.expiresAt,
          settlement: quote.settlement,
          memoHash: quote.memoHash,
        },
        accepts: quote.settlement.map((mode) => ({
          scheme: "solana-spl",
          network: quote.network,
          mint: quote.mint,
          maxAmount: quote.totalAtomic,
          recipient: quote.recipient,
          mode,
        })),
        recommendedMode: quote.settlement[0],
        commitEndpoint: `${baseUrl}/commit`,
        finalizeEndpoint: `${baseUrl}/finalize`,
        receiptEndpoint: `${baseUrl}/receipt/:receiptId`,
      },
    });
  };
}
