import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { PaymentVerifier } from "../paymentVerifier.js";
import { computeRequestDigest, computeResponseDigest, ReceiptSigner } from "../receipts.js";
import type { PaymentAccept, PaymentProof, SignedReceipt } from "../types.js";
import {
  createPaymentVerifier,
  defaultUsdcMintForNetwork,
  inferPaymentNetwork,
  SupportedNetwork,
  verificationFailureStatus,
} from "./paymentSupport.js";

export interface PaywallOptions {
  priceAtomic: string;
  mint?: string;
  recipient: string;
  quoteTtlSeconds?: number;
  settlement?: Array<"transfer" | "stream" | "netting">;
  network?: SupportedNetwork;
  solanaRpcUrl?: string;
  paymentVerifier?: PaymentVerifier;
  maxTransferProofAgeSeconds?: number;
  unsafeUnverifiedNettingEnabled?: boolean;
  receiptSigner?: ReceiptSigner;
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
  resource: string;
  network: PaymentAccept["network"];
  paymentVerifier: PaymentVerifier;
  receiptSigner: ReceiptSigner;
  onPaymentVerified?: (receipt: unknown, req: Request) => void;
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
  onPaymentVerified?: (receipt: unknown, req: Request) => void;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface PaywallRuntime {
  quotes: Map<string, QuoteRecord>;
  commits: Map<string, CommitRecord>;
  receipts: Map<string, ReceiptRecord>;
  paidCommits: Set<string>;
  routesMounted: boolean;
}

const PAYWALL_RUNTIME_KEY = "__dnaPaywallRuntime";

function hashHex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function createReceiptPayload(receipt: ReceiptRecord) {
  return receipt.signedReceipt;
}

function issueDeliveryReceipt(
  runtime: PaywallRuntime,
  commitId: string,
  req: Request,
  responseBody: Record<string, unknown>,
  statusCode = 200,
): SignedReceipt | undefined {
  const commit = runtime.commits.get(commitId);
  if (!commit) {
    return undefined;
  }
  const quote = runtime.quotes.get(commit.quoteId);
  const paymentReceipt = commit.receiptId ? runtime.receipts.get(commit.receiptId) : undefined;
  if (!quote || !paymentReceipt) {
    return undefined;
  }

  const signedReceipt = quote.receiptSigner.sign({
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
    amountAtomic: quote.priceAtomic,
    feeAtomic: "0",
    totalAtomic: quote.priceAtomic,
    settlement: paymentReceipt.signedReceipt.payload.settlement,
    settledOnchain: paymentReceipt.signedReceipt.payload.settledOnchain,
    txSignature: paymentReceipt.signedReceipt.payload.txSignature,
    createdAt: new Date().toISOString(),
  });

  runtime.receipts.set(signedReceipt.payload.receiptId, { signedReceipt });
  return signedReceipt;
}

function getRuntime(req: Request, options: PaywallOptions): PaywallRuntime {
  const locals = req.app.locals as Record<string, unknown>;
  let runtime = locals[PAYWALL_RUNTIME_KEY] as PaywallRuntime | undefined;
  if (!runtime) {
    runtime = {
      quotes: new Map<string, QuoteRecord>(),
      commits: new Map<string, CommitRecord>(),
      receipts: new Map<string, ReceiptRecord>(),
      paidCommits: new Set<string>(),
      routesMounted: false,
    };
    locals[PAYWALL_RUNTIME_KEY] = runtime;
  }

  if (!runtime.routesMounted) {
    runtime.routesMounted = true;

    req.app.post("/commit", (routeReq: Request, routeRes: Response) => {
      const { quoteId, payerCommitment32B } = routeReq.body ?? {};
      if (!quoteId || !payerCommitment32B) {
        routeRes.status(400).json({ error: "Missing quoteId or payerCommitment32B" });
        return;
      }

      const quote = runtime?.quotes.get(quoteId);
      if (!quote) {
        routeRes.status(404).json({ error: "Quote not found or expired" });
        return;
      }

      if (new Date(quote.expiresAt).getTime() < Date.now()) {
        runtime?.quotes.delete(quoteId);
        routeRes.status(410).json({ error: "Quote expired" });
        return;
      }

      const commitId = crypto.randomUUID();
      runtime?.commits.set(commitId, {
        commitId,
        quoteId,
        payerCommitment: payerCommitment32B,
        createdAt: new Date().toISOString(),
        finalized: false,
      });

      routeRes.status(201).json({ commitId, quoteId, expiresAt: quote.expiresAt });
    });

    req.app.post("/finalize", async (routeReq: Request, routeRes: Response) => {
      const { commitId, paymentProof } = routeReq.body ?? {};
      if (!commitId) {
        routeRes.status(400).json({ error: "Missing commitId" });
        return;
      }

      const commit = runtime?.commits.get(commitId);
      if (!commit) {
        routeRes.status(404).json({ error: "Commit not found" });
        return;
      }

      if (commit.finalized) {
        routeRes.status(409).json({ error: "Already finalized", receiptId: commit.receiptId });
        return;
      }

      const quote = runtime?.quotes.get(commit.quoteId);
      if (!quote) {
        routeRes.status(410).json({ error: "Quote expired" });
        return;
      }

      const proof = paymentProof as PaymentProof | undefined;
      if (!proof || (proof.settlement !== "transfer" && proof.settlement !== "stream" && proof.settlement !== "netting")) {
        routeRes.status(400).json({ error: "Missing or invalid paymentProof" });
        return;
      }

      if (!quote.settlement.includes(proof.settlement)) {
        routeRes.status(400).json({ error: `Unsupported settlement mode: ${proof.settlement}` });
        return;
      }

      const verification = await quote.paymentVerifier.verify({
        quoteId: quote.quoteId,
        resource: routeReq.path,
        amountAtomic: quote.priceAtomic,
        feeAtomic: "0",
        totalAtomic: quote.priceAtomic,
        mint: quote.mint,
        recipient: quote.recipient,
        expiresAt: quote.expiresAt,
        settlement: quote.settlement as Array<"transfer" | "stream" | "netting">,
        memoHash: quote.memoHash,
      }, proof);

      if (!verification?.ok) {
        routeRes.status(verificationFailureStatus(verification ?? { ok: false, settledOnchain: false })).json({
          ok: false,
          error: {
            code: verification?.errorCode ?? "PAYMENT_INVALID",
            message: verification?.error ?? "Payment verification failed",
            retryable: verification?.retryable ?? false,
          },
        });
        return;
      }

      const receiptId = crypto.randomUUID();
      const finalizeResponse = { ok: true, receiptId, commitId, settlement: proof.settlement };
      const receipt: ReceiptRecord = {
        signedReceipt: quote.receiptSigner.sign({
          receiptId,
          quoteId: commit.quoteId,
          commitId,
          resource: quote.resource,
          requestId: commitId,
          requestDigest: computeRequestDigest({ method: routeReq.method, path: routeReq.path, body: routeReq.body }),
          responseDigest: computeResponseDigest({ status: 200, body: finalizeResponse }),
          shopId: "self",
          payerCommitment32B: commit.payerCommitment,
          recipient: quote.recipient,
          mint: quote.mint,
          amountAtomic: quote.priceAtomic,
          feeAtomic: "0",
          totalAtomic: quote.priceAtomic,
          settlement: proof.settlement,
          settledOnchain: verification.settledOnchain,
          txSignature: verification.txSignature,
          createdAt: new Date().toISOString(),
        }),
        onPaymentVerified: quote.onPaymentVerified,
      };

      runtime?.receipts.set(receiptId, receipt);
      commit.finalized = true;
      commit.receiptId = receiptId;
      runtime?.paidCommits.add(commitId);

      routeRes.json(finalizeResponse);
    });

    req.app.get("/receipt/:id", (routeReq: Request, routeRes: Response) => {
      const receipt = runtime?.receipts.get(routeReq.params.id as string);
      if (!receipt) {
        routeRes.status(404).json({ error: "Receipt not found" });
        return;
      }

      routeRes.json(createReceiptPayload(receipt));
    });
  }

  return runtime;
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
  const network = inferPaymentNetwork(options.network, options.solanaRpcUrl);
  const ttl = options.quoteTtlSeconds ?? 180;
  const mint = options.mint ?? defaultUsdcMintForNetwork(options.network, options.solanaRpcUrl);
  const settlement = options.settlement ?? ["transfer"];
  const paymentVerifier = createPaymentVerifier({
    rpcUrl: options.solanaRpcUrl,
    maxTransferProofAgeSeconds: options.maxTransferProofAgeSeconds,
    allowUnverifiedNetting: options.unsafeUnverifiedNettingEnabled,
    paymentVerifier: options.paymentVerifier,
  });
  const receiptSigner = options.receiptSigner ?? ReceiptSigner.generate();

  return function paywallMiddleware(req: Request, res: Response, next: NextFunction): void {
    const runtime = getRuntime(req, options);

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
    if (commitId && runtime.paidCommits.has(commitId)) {
      runtime.paidCommits.delete(commitId);
      const receiptId = runtime.commits.get(commitId)?.receiptId;
      if (receiptId) {
        const receipt = runtime.receipts.get(receiptId);
        if (receipt?.onPaymentVerified) {
          receipt.onPaymentVerified(createReceiptPayload(receipt), req);
        }
      }
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (!isJsonRecord(body)) {
          return originalJson(body);
        }
        const deliveryReceipt = issueDeliveryReceipt(runtime, commitId, req, body, res.statusCode || 200);
        return originalJson(deliveryReceipt ? { ...body, receipt: deliveryReceipt } : body);
      }) as typeof res.json;
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
      resource: req.path,
      network,
      paymentVerifier,
      receiptSigner,
      onPaymentVerified: options.onPaymentVerified,
    };
    runtime.quotes.set(quoteId, quote);

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
          network,
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
