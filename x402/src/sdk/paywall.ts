import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export interface PaywallOptions {
  priceAtomic: string;
  mint?: string;
  recipient: string;
  quoteTtlSeconds?: number;
  settlement?: Array<"transfer" | "stream" | "netting">;
  requireApiKey?: boolean;
  apiKeyHeader?: string;
  apiKeys?: Set<string>;
  onPaymentVerified?: (receipt: unknown, req: Request) => void;
}

interface QuoteRecord {
  quoteId: string;
  priceAtomic: string;
  mint: string;
  recipient: string;
  expiresAt: string;
  settlement: string[];
  memoHash: string;
}

function hashHex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * Express middleware that gates any route behind a DNA x402 payment.
 *
 * Usage:
 *   app.use("/api/inference", dnaPaywall({ priceAtomic: "5000", recipient: "YOUR_WALLET" }));
 *
 * Agent flow:
 *   1. GET /api/inference -> 402 with paymentRequirements JSON
 *   2. Agent pays, gets commitId
 *   3. GET /api/inference with x-dnp-commit-id header -> 200
 */
export function dnaPaywall(options: PaywallOptions) {
  const quotes = new Map<string, QuoteRecord>();
  const paidCommits = new Set<string>();
  const ttl = options.quoteTtlSeconds ?? 180;
  const mint = options.mint ?? "USDC";
  const settlement = options.settlement ?? ["transfer"];

  return function paywallMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (options.requireApiKey) {
      const headerName = options.apiKeyHeader ?? "x-api-key";
      const key = req.header(headerName);
      if (!key || !options.apiKeys?.has(key)) {
        res.status(401).json({
          error: "unauthorized",
          message: "Valid API key required",
          header: headerName,
        });
        return;
      }
    }

    const commitId = req.header("x-dnp-commit-id");
    if (commitId && paidCommits.has(commitId)) {
      paidCommits.delete(commitId);
      next();
      return;
    }

    const now = new Date();
    const quoteId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
    const memoHash = hashHex(`${quoteId}:${req.path}:${options.priceAtomic}:${expiresAt}`);

    const quote: QuoteRecord = {
      quoteId,
      priceAtomic: options.priceAtomic,
      mint,
      recipient: options.recipient,
      expiresAt,
      settlement,
      memoHash,
    };
    quotes.set(quoteId, quote);

    const baseUrl = `${req.protocol}://${req.get("host")}`;

    res.status(402).json({
      error: "payment_required",
      paymentRequirements: {
        version: "x402-dnp-v1",
        quote: {
          quoteId,
          amount: options.priceAtomic,
          feeAtomic: "0",
          totalAtomic: options.priceAtomic,
          mint,
          recipient: options.recipient,
          expiresAt,
          settlement,
          memoHash,
        },
        accepts: settlement.map((mode) => ({
          scheme: "solana-spl",
          network: "solana-mainnet",
          mint,
          maxAmount: options.priceAtomic,
          recipient: options.recipient,
          mode,
        })),
        recommendedMode: settlement[0],
        commitEndpoint: `${baseUrl}/commit`,
        finalizeEndpoint: `${baseUrl}/finalize`,
        receiptEndpoint: `${baseUrl}/receipt/:receiptId`,
      },
    });
  };
}

export function apiKeyGuard(validKeys: Set<string>, headerName = "x-api-key") {
  return function guard(req: Request, res: Response, next: NextFunction): void {
    const key = req.header(headerName);
    if (!key || !validKeys.has(key)) {
      res.status(401).json({ error: "unauthorized", header: headerName });
      return;
    }
    next();
  };
}
