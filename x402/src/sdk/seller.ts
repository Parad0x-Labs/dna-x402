/**
 * DNA x402 — Self-Contained Seller SDK
 *
 * One function to turn any Express app into a payment-accepting API.
 * Handles quotes, commits, finalization, receipts, and netting internally.
 * No separate DNA server needed.
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

export interface DnaSellerOptions {
  recipient: string;
  mint?: string;
  feeBps?: number;
  quoteTtlSeconds?: number;
  settlement?: Array<"transfer" | "netting">;
  dnaServerUrl?: string;
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
  receiptId: string;
  commitId: string;
  quoteId: string;
  settlement: string;
  amountAtomic: string;
  recipient: string;
  createdAt: string;
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

  const mint = options.mint ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const feeBps = options.feeBps ?? 0;
  const ttl = options.quoteTtlSeconds ?? 300;
  const settlement = options.settlement ?? ["netting", "transfer"];

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
  app.post("/finalize", (req: Request, res: Response) => {
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

    const proof = paymentProof ?? {};
    const settlementMode = proof.settlement ?? "netting";

    // For netting: trust the commitment (off-chain settlement)
    // For transfer: in production, verify the on-chain tx here
    // This SDK trusts the proof for simplicity — use the full DNA server for on-chain verification

    const receiptId = crypto.randomUUID();
    const receipt: ReceiptRecord = {
      receiptId,
      commitId,
      quoteId: commit.quoteId,
      settlement: settlementMode,
      amountAtomic: quote.totalAtomic,
      recipient: quote.recipient,
      createdAt: new Date().toISOString(),
    };

    receipts.set(receiptId, receipt);
    commit.finalized = true;
    commit.receiptId = receiptId;
    paidCommits.add(commitId);

    res.json({ ok: true, receiptId, commitId, settlement: settlementMode });
  });

  // GET /receipt/:id
  app.get("/receipt/:id", (req: Request, res: Response) => {
    const receipt = receipts.get(req.params.id as string);
    if (!receipt) {
      res.status(404).json({ error: "Receipt not found" });
      return;
    }
    res.json({
      payload: {
        receiptId: receipt.receiptId,
        quoteId: receipt.quoteId,
        commitId: receipt.commitId,
        settlement: receipt.settlement,
        amountAtomic: receipt.amountAtomic,
        totalAtomic: receipt.amountAtomic,
        feeAtomic: "0",
        mint,
        recipient: receipt.recipient,
        createdAt: receipt.createdAt,
        resource: "/",
        shopId: "self",
        requestDigest: "",
        responseDigest: "",
        settledOnchain: receipt.settlement === "transfer",
        txSignature: null,
      },
      signature: "self-signed",
      signerPublicKey: receipt.recipient,
      receiptHash: hashHex(receipt.receiptId),
      prevHash: "0",
    });
  });

  // GET /health
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      mode: "dna-seller-sdk",
      recipient: options.recipient,
      mint,
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
          network: "solana-mainnet",
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
