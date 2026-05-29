import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { PaymentVerifier } from "../paymentVerifier.js";
import {
  computeRequestDigest,
  computeResponseDigest,
  encodeReceiptHeader,
  normalizeCommitment32B,
  ReceiptSigner,
  RECEIPT_HEADER_NAME,
} from "../receipts.js";
import type { PaymentAccept, PaymentProof, SignedReceipt } from "../types.js";
import {
  createPaymentVerifier,
  defaultUsdcMintForNetwork,
  inferPaymentNetwork,
  SupportedNetwork,
  verificationFailureStatus,
} from "./paymentSupport.js";
import type { StreamflowClientLike } from "../verifier/streamflow.js";
import type { NegotiationPolicy } from "../negotiation/types.js";
import { evaluateOffer, parseNegotiateRound } from "../negotiation/engine.js";
import {
  SESSION_ID_HEADER,
  type SessionPolicy,
  type SessionStatusResponse,
} from "./sessionKey.js";
import {
  computePaywallFees,
  assertFeeRecipientNotProgramId,
  type PaywallFeeResult,
} from "../fees/paywallFee.js";
import {
  CHAIN_PARENT_HEADER,
  CHAIN_DEPTH_HEADER,
  MAX_CHAIN_DEPTH,
  parseChainDepth,
  type ChainLink,
  type ChainResponse,
} from "./receiptChain.js";

export interface PaywallOptions {
  priceAtomic: string;
  mint?: string;
  recipient: string;
  quoteTtlSeconds?: number;
  settlement?: Array<"transfer" | "stream" | "netting">;
  network?: SupportedNetwork;
  solanaRpcUrl?: string;
  paymentVerifier?: PaymentVerifier;
  streamflowClient?: StreamflowClientLike;
  maxTransferProofAgeSeconds?: number;
  unsafeUnverifiedNettingEnabled?: boolean;
  receiptSigner?: ReceiptSigner;
  requireApiKey?: boolean;
  apiKeyHeader?: string;
  apiKeys?: Set<string>;
  onPaymentVerified?: (receipt: unknown, req: Request) => void;
  /**
   * Called immediately after a payment is finalized and the receipt is stored.
   * Fires before the HTTP response is sent.  Use this to anchor the receipt
   * to the proof gate program or any external audit log.
   *
   * Example:
   *   const proofGate = new ProofGateClient(conn, new PublicKey(PROOF_GATE_PROGRAM_ID));
   *   dnaPaywall({
   *     ...,
   *     onReceiptFinalized: async ({ receiptId, txSignature }) => {
   *       await proofGate.anchorReceipt(payer, receiptId, txSignature);
   *     },
   *   })
   */
  /**
   * Enable session keys on this endpoint.
   *
   * After the first successful payment, the server issues a session ID in
   * the x-dnp-session-id response header.  The agent sends this header on
   * subsequent requests and is let through without a new payment until the
   * session expires or is exhausted.
   */
  session?: SessionPolicy;
  onReceiptFinalized?: (info: {
    receiptId: string;
    settlement: string;
    amountAtomic: string;
    mint: string;
    txSignature?: string;
    streamId?: string;
  }) => void | Promise<void>;
  /**
   * Enable agent price negotiation on this endpoint.
   *
   * When set, agents may bid below the listed priceAtomic.  The server counters
   * at `floorPriceAtomic` if the bid is too low, or accepts and issues the quote
   * at the agreed price.  Up to `maxRounds` rounds of back-and-forth are allowed
   * before the server falls back to a take-it-or-leave-it quote at floor price.
   *
   * floorPriceAtomic must be <= priceAtomic.
   */
  negotiation?: NegotiationPolicy;

  // ── Fee split ──────────────────────────────────────────────────────────────
  /**
   * Fee collected by whoever runs this endpoint, in basis points (1 bps = 0.01%).
   * Each app builder sets this independently — there is no global default.
   *
   * Examples:
   *   free endpoint            0
   *   light API wrapper        10  (0.1%)
   *   Parad0x commercial rail  50  (0.5%) — Parad0x's own default, not a rule
   *   high-value agent service up to 2000 (20%)
   *
   * Range: 0–2000. Default: 0.
   */
  operatorFeeBps?: number;
  /**
   * Wallet address receiving the operator fee.
   * Defaults to `recipient` if not set.
   * Must NOT be a Solana program ID — use a treasury wallet.
   */
  operatorFeeRecipient?: string;
  /**
   * Parad0x official protocol rail fee in basis points.
   * Only applies when using the official Parad0x commercial config path.
   * OSS / grant / devnet configs set this to 0 — the SDK is free to fork and use.
   *
   * Range: 0–100 (max 1%). Parad0x commercial default: 5 (0.05%).
   */
  protocolFeeBps?: number;
  /**
   * Wallet address receiving the Parad0x protocol fee.
   * Defaults to the Parad0x treasury when protocolFeeBps > 0.
   * Must NOT be a Solana program ID.
   */
  protocolFeeRecipient?: string;
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
  method: string;
  network: PaymentAccept["network"];
  paymentVerifier: PaymentVerifier;
  receiptSigner: ReceiptSigner;
  onPaymentVerified?: (receipt: unknown, req: Request) => void;
  /** Receipt chain: ID of the parent receipt this payment is part of. */
  parentReceiptId?: string;
  /** Receipt chain depth (0 = root). */
  chainDepth?: number;
  /** Fee breakdown computed at quote time. */
  fees: PaywallFeeResult;
  /** Operator fee recipient address (wallet, not program). */
  operatorFeeRecipient: string;
  /** Protocol fee recipient address (Parad0x treasury). */
  protocolFeeRecipient: string;
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

function isBinaryBody(value: unknown): value is ArrayBuffer | ArrayBufferView {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

interface SessionRecord {
  sessionId: string;
  resource: string;
  pricePerCallAtomic: string;
  maxCalls: number | null;
  maxSpendAtomic: bigint | null;
  expiresAtMs: number;
  createdAt: string;
  callsUsed: number;
  spentAtomic: bigint;
}

interface ChainRecord {
  receiptId: string;
  parentReceiptId: string | null;
  depth: number;
  amountAtomic: string;
  resource: string;
  createdAt: string;
}

interface PaywallRuntime {
  quotes: Map<string, QuoteRecord>;
  commits: Map<string, CommitRecord>;
  receipts: Map<string, ReceiptRecord>;
  paidCommits: Set<string>;
  usedTransferProofs: Map<string, string>;
  usedStreamProofs: Map<string, string>;
  sessions: Map<string, SessionRecord>;
  chains: Map<string, ChainRecord>;
  routesMounted: boolean;
}

const PAYWALL_RUNTIME_KEY = "__dnaPaywallRuntime";

function hashHex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function requestTarget(req: Request): string {
  return typeof req.originalUrl === "string" && req.originalUrl.length > 0
    ? req.originalUrl
    : req.path;
}

function requestBodyForDigest(req: Request): unknown {
  if (req.method === "GET" || req.method === "HEAD") {
    return undefined;
  }
  if (isJsonRecord(req.body) && Object.keys(req.body).length === 0) {
    return undefined;
  }
  return req.body;
}

function createReceiptPayload(receipt: ReceiptRecord) {
  return receipt.signedReceipt;
}

function issueDeliveryReceipt(
  runtime: PaywallRuntime,
  commitId: string,
  req: Request,
  responseBody: unknown,
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
      path: requestTarget(req),
      body: requestBodyForDigest(req),
    }),
    responseDigest: computeResponseDigest({
      status: statusCode,
      body: responseBody,
    }),
    shopId: "self",
    payerCommitment32B: commit.payerCommitment,
    recipient: quote.recipient,
    mint: quote.mint,
    amountAtomic: quote.fees.providerNetAtomic,
    feeAtomic: quote.fees.totalFeeAtomic,
    totalAtomic: quote.priceAtomic,
    settlement: paymentReceipt.signedReceipt.payload.settlement,
    settledOnchain: paymentReceipt.signedReceipt.payload.settledOnchain,
    txSignature: paymentReceipt.signedReceipt.payload.txSignature,
    streamId: paymentReceipt.signedReceipt.payload.streamId,
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
      usedTransferProofs: new Map<string, string>(),
      usedStreamProofs: new Map<string, string>(),
      sessions: new Map<string, SessionRecord>(),
      chains: new Map<string, ChainRecord>(),
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
      let normalizedCommitment: string;
      try {
        normalizedCommitment = normalizeCommitment32B(payerCommitment32B);
      } catch (error) {
        routeRes.status(400).json({ error: (error as Error).message });
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
        payerCommitment: normalizedCommitment,
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

      if (proof.settlement === "transfer") {
        const existingCommitId = runtime?.usedTransferProofs.get(proof.txSignature);
        if (existingCommitId && existingCommitId !== commitId) {
          routeRes.status(409).json({
            error: "Transfer proof already used",
            commitId: existingCommitId,
          });
          return;
        }
      }
      if (proof.settlement === "stream") {
        const existingCommitId = runtime?.usedStreamProofs.get(proof.streamId);
        if (existingCommitId && existingCommitId !== commitId) {
          routeRes.status(409).json({
            error: "Stream proof already used",
            commitId: existingCommitId,
          });
          return;
        }
      }

      const verification = await quote.paymentVerifier.verify({
        quoteId: quote.quoteId,
        resource: quote.resource,
        amountAtomic: quote.fees.providerNetAtomic,
        feeAtomic: quote.fees.totalFeeAtomic,
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
      if (proof.settlement === "transfer" && !verification?.txSignature) {
        routeRes.status(422).json({
          ok: false,
          error: {
            code: "PAYMENT_INVALID",
            message: "Verified transfer settlement is missing canonical txSignature",
            retryable: false,
          },
        });
        return;
      }
      if (proof.settlement === "stream" && !verification?.streamId) {
        routeRes.status(422).json({
          ok: false,
          error: {
            code: "PAYMENT_INVALID",
            message: "Verified stream settlement is missing canonical streamId",
            retryable: false,
          },
        });
        return;
      }
      if (proof.settlement === "transfer") {
        const canonicalTxSignature = verification.txSignature!;
        const canonicalCommitId = runtime?.usedTransferProofs.get(canonicalTxSignature);
        if (canonicalCommitId && canonicalCommitId !== commitId) {
          routeRes.status(409).json({
            error: "Transfer proof already used",
            commitId: canonicalCommitId,
          });
          return;
        }
      }
      if (proof.settlement === "stream") {
        const canonicalStreamId = verification.streamId!;
        const canonicalCommitId = runtime?.usedStreamProofs.get(canonicalStreamId);
        if (canonicalCommitId && canonicalCommitId !== commitId) {
          routeRes.status(409).json({
            error: "Stream proof already used",
            commitId: canonicalCommitId,
          });
          return;
        }
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
          requestDigest: computeRequestDigest({ method: routeReq.method, path: requestTarget(routeReq), body: requestBodyForDigest(routeReq) }),
          responseDigest: computeResponseDigest({ status: 200, body: finalizeResponse }),
          shopId: "self",
          payerCommitment32B: commit.payerCommitment,
          recipient: quote.recipient,
          mint: quote.mint,
          amountAtomic: quote.fees.providerNetAtomic,
          feeAtomic: quote.fees.totalFeeAtomic,
          totalAtomic: quote.priceAtomic,
          settlement: proof.settlement,
          settledOnchain: verification.settledOnchain,
          txSignature: verification.txSignature,
          streamId: verification.streamId,
          createdAt: new Date().toISOString(),
        }),
        onPaymentVerified: quote.onPaymentVerified,
      };

      runtime?.receipts.set(receiptId, receipt);
      if (proof.settlement === "transfer") {
        const canonicalTxSignature = verification.txSignature!;
        runtime?.usedTransferProofs.set(canonicalTxSignature, commitId);
      }
      if (proof.settlement === "stream") {
        const canonicalStreamId = verification.streamId!;
        runtime?.usedStreamProofs.set(canonicalStreamId, commitId);
      }
      commit.finalized = true;
      commit.receiptId = receiptId;
      runtime?.paidCommits.add(commitId);

      // ── Chain linkage ───────────────────────────────────────────────────────
      // If this payment was made as part of a receipt chain, record the link.
      const parentReceiptId = quote.parentReceiptId ?? null;
      const chainDepth = quote.chainDepth ?? 0;
      runtime?.chains.set(receiptId, {
        receiptId,
        parentReceiptId,
        depth: chainDepth,
        amountAtomic: quote.priceAtomic,
        resource: quote.resource,
        createdAt: new Date().toISOString(),
      });

      // ── Session creation ────────────────────────────────────────────────────
      let newSessionId: string | undefined;
      if (options.session?.enabled) {
        const sessionPolicy = options.session;
        const ttlMs = (sessionPolicy.ttlSeconds ?? 3600) * 1000;
        newSessionId = crypto.randomUUID();
        const maxCalls = sessionPolicy.maxCalls ?? null;
        const maxSpendBigInt = sessionPolicy.maxSpendAtomic
          ? BigInt(sessionPolicy.maxSpendAtomic)
          : null;
        runtime?.sessions.set(newSessionId, {
          sessionId: newSessionId,
          resource: quote.resource,
          pricePerCallAtomic: quote.priceAtomic,
          maxCalls,
          maxSpendAtomic: maxSpendBigInt,
          expiresAtMs: Date.now() + ttlMs,
          createdAt: new Date().toISOString(),
          callsUsed: 0,
          spentAtomic: 0n,
        });
      }

      const finalizePayload = newSessionId
        ? { ...finalizeResponse, sessionId: newSessionId }
        : finalizeResponse;

      // Fire the receipt-finalized hook (non-blocking — errors must not abort the response).
      if (options.onReceiptFinalized) {
        Promise.resolve(
          options.onReceiptFinalized({
            receiptId,
            settlement: proof.settlement,
            amountAtomic: quote.fees.providerNetAtomic,
            mint: quote.mint,
            txSignature: verification.txSignature,
            streamId: verification.streamId,
          }),
        ).catch((err: unknown) => {
          // Log but swallow — payment is finalized regardless of anchor outcome.
          console.error("[dnaPaywall] onReceiptFinalized error (non-fatal):", err);
        });
      }

      routeRes.json(finalizePayload);
    });

    req.app.get("/receipt/:id", (routeReq: Request, routeRes: Response) => {
      const receipt = runtime?.receipts.get(routeReq.params.id as string);
      if (!receipt) {
        routeRes.status(404).json({ error: "Receipt not found" });
        return;
      }

      routeRes.json(createReceiptPayload(receipt));
    });

    // ── Session status endpoint ───────────────────────────────────────────────
    req.app.get("/session/:id", (routeReq: Request, routeRes: Response) => {
      const session = runtime?.sessions.get(routeReq.params.id as string);
      if (!session) {
        routeRes.status(404).json({ error: "Session not found or expired" });
        return;
      }

      const now = Date.now();
      const active = session.expiresAtMs > now;
      const callsRemaining = session.maxCalls !== null
        ? Math.max(0, session.maxCalls - session.callsUsed)
        : null;
      const remainingSpendAtomic = session.maxSpendAtomic !== null
        ? String(session.maxSpendAtomic - session.spentAtomic > 0n
            ? session.maxSpendAtomic - session.spentAtomic
            : 0n)
        : null;

      const status: SessionStatusResponse = {
        sessionId: session.sessionId,
        resource: session.resource,
        callsUsed: session.callsUsed,
        callsRemaining,
        spentAtomic: String(session.spentAtomic),
        remainingSpendAtomic,
        expiresAt: new Date(session.expiresAtMs).toISOString(),
        active,
      };
      routeRes.json(status);
    });

    // ── Receipt chain endpoint ────────────────────────────────────────────────
    req.app.get("/receipt/:id/chain", (routeReq: Request, routeRes: Response) => {
      const startId = routeReq.params.id as string;
      const startLink = runtime?.chains.get(startId);
      if (!startLink) {
        routeRes.status(404).json({ error: "Receipt chain not found" });
        return;
      }

      // Traverse up to root.
      const chain: ChainLink[] = [];
      let current: ChainRecord | undefined = startLink;
      while (current) {
        chain.unshift({
          receiptId: current.receiptId,
          parentReceiptId: current.parentReceiptId,
          depth: current.depth,
          amountAtomic: current.amountAtomic,
          resource: current.resource,
          createdAt: current.createdAt,
        });
        current = current.parentReceiptId ? runtime?.chains.get(current.parentReceiptId) : undefined;
      }

      const totalAmount = chain.reduce((sum, l) => sum + BigInt(l.amountAtomic), 0n);
      const response: ChainResponse = {
        root: chain[0] as ChainLink,
        chain,
        totalDepth: chain.length - 1,
        totalAmountAtomic: String(totalAmount),
      };
      routeRes.json(response);
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
// Default Parad0x protocol treasury — receives protocolFee when protocolFeeBps > 0.
const PARAD0X_TREASURY = "F6Fr2Sn6jLMbpLMcg7ezrwNLZxs9MM8RYyifUAvP72BY";

export function dnaPaywall(options: PaywallOptions) {
  const network = inferPaymentNetwork(options.network, options.solanaRpcUrl);
  const ttl = options.quoteTtlSeconds ?? 180;
  const mint = options.mint ?? defaultUsdcMintForNetwork(options.network, options.solanaRpcUrl);
  const settlement = options.settlement ?? ["transfer"];
  const paymentVerifier = createPaymentVerifier({
    rpcUrl: options.solanaRpcUrl,
    maxTransferProofAgeSeconds: options.maxTransferProofAgeSeconds,
    allowUnverifiedNetting: options.unsafeUnverifiedNettingEnabled,
    streamflowClient: options.streamflowClient,
    paymentVerifier: options.paymentVerifier,
  });
  const receiptSigner = options.receiptSigner ?? ReceiptSigner.generate();

  // ── Fee config validation (fail-fast at startup, not per-request) ──────────
  const operatorFeeBps = options.operatorFeeBps ?? 0;
  const protocolFeeBps = options.protocolFeeBps ?? 0;
  const resolvedOperatorFeeRecipient = options.operatorFeeRecipient ?? options.recipient;
  const resolvedProtocolFeeRecipient = options.protocolFeeRecipient ?? (protocolFeeBps > 0 ? PARAD0X_TREASURY : options.recipient);

  // Validate fee recipients are wallet addresses, not program IDs.
  // We pass an empty set here — integrators with configs should validate at deploy time.
  if (operatorFeeBps > 0) {
    assertFeeRecipientNotProgramId(resolvedOperatorFeeRecipient);
  }
  if (protocolFeeBps > 0) {
    assertFeeRecipientNotProgramId(resolvedProtocolFeeRecipient);
  }
  // Pre-validate fee bps ranges (throws immediately if misconfigured).
  computePaywallFees(options.priceAtomic, operatorFeeBps, protocolFeeBps);
  // ── End fee config validation ──────────────────────────────────────────────

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

    // ── Session gate ──────────────────────────────────────────────────────────
    // Check for a valid session before requiring a new payment.
    const incomingSessionId = req.header(SESSION_ID_HEADER);
    if (incomingSessionId) {
      const session = runtime.sessions.get(incomingSessionId);
      if (!session) {
        res.status(402).json({
          error: "payment_required",
          sessionError: "session not found or expired",
        });
        return;
      }
      const now = Date.now();
      if (session.expiresAtMs <= now) {
        runtime.sessions.delete(incomingSessionId);
        res.status(402).json({
          error: "payment_required",
          sessionError: "session expired",
        });
        return;
      }
      if (session.maxCalls !== null && session.callsUsed >= session.maxCalls) {
        res.status(402).json({
          error: "payment_required",
          sessionError: `session exhausted (${session.callsUsed}/${session.maxCalls} calls used)`,
        });
        return;
      }
      if (
        session.maxSpendAtomic !== null
        && session.spentAtomic >= session.maxSpendAtomic
      ) {
        res.status(402).json({
          error: "payment_required",
          sessionError: "session spend limit reached",
        });
        return;
      }
      // Session valid — update usage and pass through.
      session.callsUsed += 1;
      session.spentAtomic += BigInt(session.pricePerCallAtomic);
      res.setHeader(SESSION_ID_HEADER, incomingSessionId);
      next();
      return;
    }
    // ── End session gate ──────────────────────────────────────────────────────

    const commitId = req.header("x-dnp-commit-id");
    const paidCommit = commitId ? runtime.commits.get(commitId) : undefined;
    const paidQuote = paidCommit ? runtime.quotes.get(paidCommit.quoteId) : undefined;
    if (
      commitId
      && runtime.paidCommits.has(commitId)
      && paidCommit?.finalized
      && paidQuote?.method === req.method.toUpperCase()
      && paidQuote?.resource === requestTarget(req)
    ) {
      runtime.paidCommits.delete(commitId);
      res.once("finish", () => {
        if ((res.statusCode ?? 200) >= 400) {
          runtime.paidCommits.add(commitId);
          return;
        }
        const receiptId = runtime.commits.get(commitId)?.receiptId;
        if (!receiptId) {
          return;
        }
        const receipt = runtime.receipts.get(receiptId);
        if (receipt?.onPaymentVerified) {
          receipt.onPaymentVerified(createReceiptPayload(receipt), req);
        }
      });
      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);
      const mutableRes = res as Response & {
        write?: (...args: any[]) => any;
        end?: (...args: any[]) => any;
        redirect?: (...args: any[]) => any;
        sendFile?: (...args: any[]) => any;
        download?: (...args: any[]) => any;
        render?: (...args: any[]) => any;
      };
      const originalWrite = mutableRes.write?.bind(res);
      const originalEnd = mutableRes.end?.bind(res);
      const originalRedirect = mutableRes.redirect?.bind(res);
      const originalSendFile = mutableRes.sendFile?.bind(res);
      const originalDownload = mutableRes.download?.bind(res);
      const originalRender = mutableRes.render?.bind(res);
      let deliveryReceiptIssued = false;
      let allowNativeBodyWrite = false;
      let unsupportedDeliveryRejected = false;
      const attachDeliveryReceipt = (body: unknown): SignedReceipt | undefined => {
        if (deliveryReceiptIssued || (res.statusCode ?? 200) >= 400) {
          return undefined;
        }
        const deliveryReceipt = issueDeliveryReceipt(runtime, commitId, req, body, res.statusCode || 200);
        if (deliveryReceipt) {
          res.setHeader(RECEIPT_HEADER_NAME, encodeReceiptHeader(deliveryReceipt));
          deliveryReceiptIssued = true;
        }
        return deliveryReceipt;
      };
      const rejectUnsupportedDelivery = (): boolean => {
        if (unsupportedDeliveryRejected) {
          return false;
        }
        unsupportedDeliveryRejected = true;
        res.status(501);
        allowNativeBodyWrite = true;
        try {
          originalJson({
            error: "unsupported_delivery_mode",
            message: "dnaPaywall protected responses must use res.json or res.send for verifiable delivery",
          });
        } finally {
          allowNativeBodyWrite = false;
        }
        return false;
      };
      res.json = ((body: unknown) => {
        allowNativeBodyWrite = true;
        try {
          if ((res.statusCode ?? 200) >= 400) {
            return originalJson(body);
          }
          const deliveryReceipt = attachDeliveryReceipt(body);
          if (deliveryReceipt && isJsonRecord(body)) {
            return originalJson({ ...body, receipt: deliveryReceipt });
          }
          return originalJson(body);
        } finally {
          allowNativeBodyWrite = false;
        }
      }) as typeof res.json;
      res.send = ((body: unknown) => {
        allowNativeBodyWrite = true;
        try {
          if (deliveryReceiptIssued || (res.statusCode ?? 200) >= 400 || (!isBinaryBody(body) && typeof body !== "string")) {
            return originalSend(body as never);
          }
          attachDeliveryReceipt(body);
          return originalSend(body as never);
        } finally {
          allowNativeBodyWrite = false;
        }
      }) as typeof res.send;
      if (originalWrite) {
        mutableRes.write = ((...args: any[]) => {
          if (allowNativeBodyWrite || deliveryReceiptIssued || (res.statusCode ?? 200) >= 400) {
            return originalWrite(...args);
          }
          if (unsupportedDeliveryRejected) {
            return false;
          }
          return rejectUnsupportedDelivery();
        }) as typeof mutableRes.write;
      }
      if (originalEnd) {
        mutableRes.end = ((...args: any[]) => {
          if (allowNativeBodyWrite || deliveryReceiptIssued || (res.statusCode ?? 200) >= 400) {
            return originalEnd(...args);
          }
          if (unsupportedDeliveryRejected) {
            return res;
          }
          rejectUnsupportedDelivery();
          return res;
        }) as typeof mutableRes.end;
      }
      const rejectUnsupportedResponseHelper = (): Response => {
        rejectUnsupportedDelivery();
        return res;
      };
      if (originalRedirect) {
        mutableRes.redirect = ((...args: any[]) => {
          if (allowNativeBodyWrite || deliveryReceiptIssued || (res.statusCode ?? 200) >= 400) {
            return originalRedirect(...args);
          }
          return rejectUnsupportedResponseHelper();
        }) as typeof mutableRes.redirect;
      }
      if (originalSendFile) {
        mutableRes.sendFile = ((...args: any[]) => {
          if (allowNativeBodyWrite || deliveryReceiptIssued || (res.statusCode ?? 200) >= 400) {
            return originalSendFile(...args);
          }
          return rejectUnsupportedResponseHelper();
        }) as typeof mutableRes.sendFile;
      }
      if (originalDownload) {
        mutableRes.download = ((...args: any[]) => {
          if (allowNativeBodyWrite || deliveryReceiptIssued || (res.statusCode ?? 200) >= 400) {
            return originalDownload(...args);
          }
          return rejectUnsupportedResponseHelper();
        }) as typeof mutableRes.download;
      }
      if (originalRender) {
        mutableRes.render = ((...args: any[]) => {
          if (allowNativeBodyWrite || deliveryReceiptIssued || (res.statusCode ?? 200) >= 400) {
            return originalRender(...args);
          }
          return rejectUnsupportedResponseHelper();
        }) as typeof mutableRes.render;
      }
      next();
      return;
    } // end paidCommit gate

    const now = new Date();
    const quoteId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
    const target = requestTarget(req);
    const method = req.method.toUpperCase();

    // ── Receipt chain headers ──────────────────────────────────────────────────
    const incomingParentReceiptId = req.header(CHAIN_PARENT_HEADER) ?? undefined;
    const incomingChainDepth = parseChainDepth(req.header(CHAIN_DEPTH_HEADER));
    if (incomingParentReceiptId && incomingChainDepth > MAX_CHAIN_DEPTH) {
      res.status(400).json({
        error: "chain_depth_exceeded",
        message: `Receipt chain depth ${incomingChainDepth} exceeds maximum ${MAX_CHAIN_DEPTH}`,
      });
      return;
    }
    // ── End chain headers ──────────────────────────────────────────────────────

    // ── Negotiation ────────────────────────────────────────────────────────────
    // If the endpoint has a NegotiationPolicy, check for an agent bid in the
    // x-dnp-offer header.  Three outcomes:
    //   1. No offer header → advertise negotiability in the 402, issue quote at listed price.
    //   2. Offer accepted (>= floor) → issue quote at agreed price, no negotiation block.
    //   3. Offer rejected (< floor, round < maxRounds) → return 402 counter with NO quote;
    //      agent must retry.  On the final round we accept at floor unconditionally.
    const offerHeader = req.header("x-dnp-offer");
    const negotiateRound = parseNegotiateRound(req.header("x-dnp-negotiate-round"));

    let effectivePriceAtomic = options.priceAtomic;
    let negotiationAdvertisement: object | undefined;

    if (options.negotiation?.enabled) {
      const policy = options.negotiation;

      if (offerHeader) {
        const result = evaluateOffer(offerHeader, options.priceAtomic, policy, negotiateRound);
        if (result.accepted) {
          effectivePriceAtomic = result.agreedPriceAtomic;
          // No negotiation block attached — quote already reflects agreed price.
        } else {
          // Counter-offer: return 402 with negotiation block only, no paymentRequirements.
          res.status(402).json({
            error: "payment_required",
            negotiation: {
              enabled: true,
              floorPriceAtomic: policy.floorPriceAtomic,
              listedPriceAtomic: options.priceAtomic,
              counterPriceAtomic: result.counterPriceAtomic,
              round: result.nextRound,
              maxRounds: policy.maxRounds ?? 2,
            },
          });
          return;
        }
      } else {
        // No bid — advertise that negotiation is possible so agents know to send x-dnp-offer.
        negotiationAdvertisement = {
          enabled: true,
          floorPriceAtomic: policy.floorPriceAtomic,
          listedPriceAtomic: options.priceAtomic,
          maxRounds: policy.maxRounds ?? 2,
        };
      }
    }
    // ── End negotiation ────────────────────────────────────────────────────────

    const memoHash = hashHex(`${quoteId}:${method}:${target}:${effectivePriceAtomic}:${expiresAt}`);

    // Recompute fees against the negotiated price (may differ from options.priceAtomic).
    const quoteFees = computePaywallFees(effectivePriceAtomic, operatorFeeBps, protocolFeeBps);

    const quote: QuoteRecord = {
      quoteId,
      priceAtomic: effectivePriceAtomic,
      mint,
      recipient: options.recipient,
      expiresAt,
      settlement,
      memoHash,
      resource: target,
      method,
      network,
      paymentVerifier,
      receiptSigner,
      onPaymentVerified: options.onPaymentVerified,
      parentReceiptId: incomingParentReceiptId,
      chainDepth: incomingParentReceiptId ? incomingChainDepth : undefined,
      fees: quoteFees,
      operatorFeeRecipient: resolvedOperatorFeeRecipient,
      protocolFeeRecipient: resolvedProtocolFeeRecipient,
    };
    runtime.quotes.set(quoteId, quote);

    const baseUrl = `${req.protocol}://${req.get("host")}`;

    res.status(402).json({
      error: "payment_required",
      ...(negotiationAdvertisement ? { negotiation: negotiationAdvertisement } : {}),
      paymentRequirements: {
        version: "x402-dnp-v1",
        quote: {
          quoteId,
          amount: effectivePriceAtomic,
          feeAtomic: quoteFees.totalFeeAtomic,
          totalAtomic: effectivePriceAtomic,  // payer sends priceAtomic; fees deducted from it
          providerNetAtomic: quoteFees.providerNetAtomic,
          mint,
          recipient: options.recipient,
          expiresAt,
          settlement,
          memoHash,
          ...(operatorFeeBps > 0 || protocolFeeBps > 0
            ? {
                feeBreakdown: {
                  operatorFeeAtomic: quoteFees.operatorFeeAtomic,
                  operatorFeeBps,
                  operatorFeeRecipient: resolvedOperatorFeeRecipient,
                  protocolFeeAtomic: quoteFees.protocolFeeAtomic,
                  protocolFeeBps,
                  protocolFeeRecipient: resolvedProtocolFeeRecipient,
                },
              }
            : {}),
        },
        accepts: settlement.map((mode) => ({
          scheme: "solana-spl",
          network,
          mint,
          maxAmount: effectivePriceAtomic,
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
