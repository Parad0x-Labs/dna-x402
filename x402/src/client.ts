import { parseAtomic } from "./feePolicy.js";
import { PaymentProof, PaymentRequirements, QuoteResponse, SignedReceipt } from "./types.js";
import crypto from "node:crypto";
import { MarketPolicy, marketPolicySchema, quoteQueryFromPolicy, selectQuoteByPolicy } from "./market/policy.js";
import { MarketOrder, MarketQuote } from "./market/types.js";
import {
  computeRequestDigest,
  computeResponseDigest,
  decodeReceiptHeader,
  normalizeCommitment32B,
  RECEIPT_HEADER_NAME,
  verifySignedReceipt,
} from "./receipts.js";
import { encodeCanonicalProofHeader, normalizeX402 } from "./x402/compat/parse.js";
import { CanonicalPaymentProof } from "./x402/compat/types.js";

export interface AgentWallet {
  payTransfer(quote: QuoteResponse): Promise<PaymentProof>;
  payStream?(quote: QuoteResponse): Promise<PaymentProof>;
  payNetted?(quote: QuoteResponse): Promise<PaymentProof>;
}

export interface ReceiptStore {
  save(receipt: SignedReceipt): Promise<void> | void;
}

export class InMemoryReceiptStore implements ReceiptStore {
  readonly receipts = new Map<string, SignedReceipt>();

  save(receipt: SignedReceipt): void {
    this.receipts.set(receipt.payload.receiptId, receipt);
  }
}

export interface FetchWith402Options extends RequestInit {
  wallet: AgentWallet;
  maxSpendAtomic: string;
  maxPriceAtomic?: string;
  maxSpendPerDayAtomic?: string;
  payerCommitment32B?: string;
  preferStream?: boolean;
  preferNetting?: boolean;
  proofHeaderStyle?: "PAYMENT-SIGNATURE" | "X-PAYMENT" | "X-402-PAYMENT";
  receiptStore?: ReceiptStore;
  spendTracker?: SpendTracker;
}

export interface FetchWith402Result {
  response: Response;
  commitId?: string;
  receipt?: SignedReceipt;
  paymentRequirements?: PaymentRequirements;
}

export interface MarketCallOptions extends RequestInit {
  wallet: AgentWallet;
  marketPolicy: MarketPolicy;
  marketBaseUrl: string;
  resourceBaseUrl?: string;
  maxSpendAtomic?: string;
  receiptStore?: ReceiptStore;
  spendTracker?: SpendTracker;
}

export interface MarketCallResult extends FetchWith402Result {
  selectedQuote: MarketQuote;
  provider: {
    shopId: string;
    endpointId: string;
    path: string;
  };
  orderId?: string;
}

interface FinalizeResponse {
  ok: boolean;
  receiptId: string;
}

function isReceiptBoundRoute(pathname: string): boolean {
  return pathname === "/resource"
    || pathname === "/inference"
    || pathname.startsWith("/audit/primitives/");
}

function requestTargetFromUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  return `${parsed.pathname}${parsed.search}`;
}

function assertReceiptIntegrity(
  receipt: SignedReceipt,
  expected: {
    quoteId: string;
    commitId: string;
    payerCommitment32B?: string;
    recipient: string;
    mint: string;
    totalAtomic: string;
    settlement: PaymentProof["settlement"];
  },
): void {
  if (!verifySignedReceipt(receipt)) {
    throw new Error("Receipt verification failed: invalid signature or tampered payload");
  }

  if (receipt.payload.quoteId !== expected.quoteId) {
    throw new Error(`Receipt verification failed: quoteId mismatch (${receipt.payload.quoteId})`);
  }
  if (receipt.payload.commitId !== expected.commitId) {
    throw new Error(`Receipt verification failed: commitId mismatch (${receipt.payload.commitId})`);
  }
  if (expected.payerCommitment32B && receipt.payload.payerCommitment32B !== expected.payerCommitment32B) {
    throw new Error(`Receipt verification failed: payerCommitment32B mismatch (${receipt.payload.payerCommitment32B})`);
  }
  if (receipt.payload.recipient !== expected.recipient) {
    throw new Error(`Receipt verification failed: recipient mismatch (${receipt.payload.recipient})`);
  }
  if (receipt.payload.mint !== expected.mint) {
    throw new Error(`Receipt verification failed: mint mismatch (${receipt.payload.mint})`);
  }
  if (receipt.payload.totalAtomic !== expected.totalAtomic) {
    throw new Error(`Receipt verification failed: totalAtomic mismatch (${receipt.payload.totalAtomic})`);
  }
  if (receipt.payload.settlement !== expected.settlement) {
    throw new Error(`Receipt verification failed: settlement mismatch (${receipt.payload.settlement})`);
  }
  assertCanonicalReceiptSettlementIdentity(receipt);
}

function assertCanonicalReceiptSettlementIdentity(receipt: SignedReceipt): void {
  if (receipt.payload.settlement === "transfer" && !receipt.payload.txSignature) {
    throw new Error("Receipt verification failed: transfer receipt missing canonical txSignature");
  }
  if (receipt.payload.settlement === "stream" && !receipt.payload.streamId) {
    throw new Error("Receipt verification failed: stream receipt missing canonical streamId");
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextLikeContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return normalized.startsWith("text/")
    || normalized.includes("charset=")
    || normalized.startsWith("application/xml")
    || normalized.startsWith("application/javascript")
    || normalized.startsWith("application/xhtml+xml");
}

async function computeDeliveredResponseDigest(response: Response): Promise<string | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    let payload: unknown;
    try {
      payload = await response.clone().json();
    } catch {
      return undefined;
    }
    if (isJsonObject(payload)) {
      const businessBody = { ...payload };
      delete businessBody.receipt;
      return computeResponseDigest({
        status: response.status,
        body: businessBody,
      });
    }
    return computeResponseDigest({
      status: response.status,
      body: payload,
    });
  }

  if (isTextLikeContentType(contentType)) {
    try {
      return computeResponseDigest({
        status: response.status,
        body: await response.clone().text(),
      });
    } catch {
      return undefined;
    }
  }

  try {
    return computeResponseDigest({
      status: response.status,
      body: new Uint8Array(await response.clone().arrayBuffer()),
    });
  } catch {
    return undefined;
  }
}

async function assertDeliveredResponseIntegrity(
  response: Response,
  receipt: SignedReceipt,
  request: { url: string; method: string; body?: unknown },
): Promise<void> {
  if (!response.ok || !isReceiptBoundRoute(receipt.payload.resource)) {
    return;
  }

  const expectedRequestDigest = computeRequestDigest({
    method: request.method,
    path: requestTargetFromUrl(request.url),
    body: request.body,
  });
  if (receipt.payload.requestDigest !== expectedRequestDigest) {
    throw new Error("Receipt verification failed: delivered request digest mismatch");
  }

  const deliveredDigest = await computeDeliveredResponseDigest(response);
  if (!deliveredDigest) {
    return;
  }

  if (receipt.payload.responseDigest !== deliveredDigest) {
    throw new Error("Receipt verification failed: delivered response digest mismatch");
  }
}

async function extractAndVerifyEmbeddedReceipt(
  response: Response,
  expected: {
    requestUrl: string;
    method: string;
    body?: unknown;
    quoteId?: string;
    commitId?: string;
    payerCommitment32B?: string;
    recipient: string;
    mint: string;
    totalAtomic: string;
    settlement: PaymentProof["settlement"];
  },
): Promise<SignedReceipt | undefined> {
  if (!response.ok) {
    return undefined;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return undefined;
  }

  let payload: unknown;
  try {
    payload = await response.clone().json();
  } catch {
    return undefined;
  }

  if (!isJsonObject(payload) || !isJsonObject(payload.receipt)) {
    return undefined;
  }

  const receipt = payload.receipt as unknown as SignedReceipt;
  if (!verifySignedReceipt(receipt)) {
    throw new Error("Receipt verification failed: invalid signature or tampered payload");
  }

  const businessBody = { ...payload };
  delete businessBody.receipt;

  const requestDigest = computeRequestDigest({
    method: expected.method,
    path: requestTargetFromUrl(expected.requestUrl),
    body: expected.body,
  });
  const responseDigest = computeResponseDigest({
    status: response.status,
    body: businessBody,
  });

  if (receipt.payload.requestDigest !== requestDigest) {
    throw new Error("Receipt verification failed: embedded request digest mismatch");
  }
  if (receipt.payload.responseDigest !== responseDigest) {
    throw new Error("Receipt verification failed: embedded response digest mismatch");
  }
  if (expected.quoteId && receipt.payload.quoteId !== expected.quoteId) {
    throw new Error(`Receipt verification failed: quoteId mismatch (${receipt.payload.quoteId})`);
  }
  if (expected.commitId && receipt.payload.commitId !== expected.commitId) {
    throw new Error(`Receipt verification failed: commitId mismatch (${receipt.payload.commitId})`);
  }
  if (expected.payerCommitment32B && receipt.payload.payerCommitment32B !== expected.payerCommitment32B) {
    throw new Error(`Receipt verification failed: payerCommitment32B mismatch (${receipt.payload.payerCommitment32B})`);
  }
  if (receipt.payload.recipient !== expected.recipient) {
    throw new Error(`Receipt verification failed: recipient mismatch (${receipt.payload.recipient})`);
  }
  if (receipt.payload.mint !== expected.mint) {
    throw new Error(`Receipt verification failed: mint mismatch (${receipt.payload.mint})`);
  }
  if (receipt.payload.totalAtomic !== expected.totalAtomic) {
    throw new Error(`Receipt verification failed: totalAtomic mismatch (${receipt.payload.totalAtomic})`);
  }
  if (receipt.payload.settlement !== expected.settlement) {
    throw new Error(`Receipt verification failed: settlement mismatch (${receipt.payload.settlement})`);
  }
  assertCanonicalReceiptSettlementIdentity(receipt);

  return receipt;
}

async function extractAndVerifyHeaderReceipt(
  response: Response,
  expected: {
    requestUrl: string;
    method: string;
    body?: unknown;
    quoteId?: string;
    commitId?: string;
    payerCommitment32B?: string;
    recipient: string;
    mint: string;
    totalAtomic: string;
    settlement: PaymentProof["settlement"];
  },
): Promise<SignedReceipt | undefined> {
  if (!response.ok) {
    return undefined;
  }

  const encoded = response.headers.get(RECEIPT_HEADER_NAME);
  if (!encoded) {
    return undefined;
  }

  let receipt: SignedReceipt;
  try {
    receipt = decodeReceiptHeader(encoded);
  } catch {
    throw new Error("Receipt verification failed: invalid receipt header");
  }

  if (!verifySignedReceipt(receipt)) {
    throw new Error("Receipt verification failed: invalid signature or tampered payload");
  }

  const requestDigest = computeRequestDigest({
    method: expected.method,
    path: requestTargetFromUrl(expected.requestUrl),
    body: expected.body,
  });
  const responseDigest = await computeDeliveredResponseDigest(response);
  if (!responseDigest) {
    throw new Error("Receipt verification failed: unsupported response type for receipt header");
  }

  if (receipt.payload.requestDigest !== requestDigest) {
    throw new Error("Receipt verification failed: header request digest mismatch");
  }
  if (receipt.payload.responseDigest !== responseDigest) {
    throw new Error("Receipt verification failed: header response digest mismatch");
  }
  if (expected.quoteId && receipt.payload.quoteId !== expected.quoteId) {
    throw new Error(`Receipt verification failed: quoteId mismatch (${receipt.payload.quoteId})`);
  }
  if (expected.commitId && receipt.payload.commitId !== expected.commitId) {
    throw new Error(`Receipt verification failed: commitId mismatch (${receipt.payload.commitId})`);
  }
  if (expected.payerCommitment32B && receipt.payload.payerCommitment32B !== expected.payerCommitment32B) {
    throw new Error(`Receipt verification failed: payerCommitment32B mismatch (${receipt.payload.payerCommitment32B})`);
  }
  if (receipt.payload.recipient !== expected.recipient) {
    throw new Error(`Receipt verification failed: recipient mismatch (${receipt.payload.recipient})`);
  }
  if (receipt.payload.mint !== expected.mint) {
    throw new Error(`Receipt verification failed: mint mismatch (${receipt.payload.mint})`);
  }
  if (receipt.payload.totalAtomic !== expected.totalAtomic) {
    throw new Error(`Receipt verification failed: totalAtomic mismatch (${receipt.payload.totalAtomic})`);
  }
  if (receipt.payload.settlement !== expected.settlement) {
    throw new Error(`Receipt verification failed: settlement mismatch (${receipt.payload.settlement})`);
  }
  assertCanonicalReceiptSettlementIdentity(receipt);

  return receipt;
}

export interface SpendTracker {
  getSpentForDateAtomic(dateKey: string): Promise<bigint> | bigint;
  addSpendForDateAtomic(dateKey: string, amountAtomic: bigint): Promise<void> | void;
}

export class InMemorySpendTracker implements SpendTracker {
  private readonly totals = new Map<string, bigint>();

  getSpentForDateAtomic(dateKey: string): bigint {
    return this.totals.get(dateKey) ?? 0n;
  }

  addSpendForDateAtomic(dateKey: string, amountAtomic: bigint): void {
    this.totals.set(dateKey, (this.totals.get(dateKey) ?? 0n) + amountAtomic);
  }
}

function absolute(url: string, endpoint: string): string {
  const base = new URL(url);
  if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) {
    return endpoint;
  }
  return new URL(endpoint, `${base.origin}/`).toString();
}

function proofHeaderName(style: FetchWith402Options["proofHeaderStyle"]): "PAYMENT-SIGNATURE" | "X-PAYMENT" | "X-402-PAYMENT" {
  if (style === "X-PAYMENT" || style === "X-402-PAYMENT") {
    return style;
  }
  return "PAYMENT-SIGNATURE";
}

function toCanonicalProof(paymentProof: PaymentProof): CanonicalPaymentProof {
  if (paymentProof.settlement === "transfer") {
    return {
      version: "x402-proof-v1",
      scheme: "solana_spl",
      txSig: paymentProof.txSignature,
      amountAtomic: paymentProof.amountAtomic,
      raw: { headers: {} },
    };
  }
  if (paymentProof.settlement === "stream") {
    return {
      version: "x402-proof-v1",
      scheme: "unknown",
      proofBlob: JSON.stringify(paymentProof),
      raw: { headers: {} },
    };
  }
  return {
    version: "x402-proof-v1",
    scheme: "unknown",
    proofBlob: JSON.stringify(paymentProof),
    raw: { headers: {} },
  };
}

function parsePaymentRequirements(payload: unknown, headers: Headers, requestUrl: string): {
  requirements: PaymentRequirements;
  headerFlow: boolean;
  requiredHeaderValue?: string;
} {
  const maybe = payload as { paymentRequirements?: PaymentRequirements };
  const requirements = maybe?.paymentRequirements;
  if (requirements?.quote?.quoteId) {
    if (!requirements.accepts || requirements.accepts.length === 0) {
      requirements.accepts = requirements.quote.settlement.map((mode) => ({
        scheme: "solana-spl",
        network: "solana-devnet",
        mint: requirements.quote.mint,
        maxAmount: requirements.quote.totalAtomic,
        recipient: requirements.quote.recipient,
        mode,
      }));
    }
    if (!requirements.recommendedMode) {
      requirements.recommendedMode = requirements.quote.settlement[0] ?? "transfer";
    }
    return { requirements, headerFlow: false };
  }

  const headerMap = Object.fromEntries(Array.from(headers.entries()));
  const normalized = normalizeX402({ headers: headerMap, body: payload });
  if (!normalized.required) {
    throw new Error("402 response missing payment requirements");
  }

  const base = new URL(requestUrl);
  const quoteId = normalized.required.memo ? `compat-${normalized.required.memo.slice(0, 24)}` : `compat-${Date.now()}`;
  const inferredRequirements: PaymentRequirements = {
    version: "x402-dnp-v1",
    quote: {
      amount: normalized.required.amountAtomic,
      mint: normalized.required.settlement.mint ?? "unknown",
      recipient: normalized.required.recipient,
      expiresAt: normalized.required.expiresAt ? new Date(normalized.required.expiresAt).toISOString() : new Date(Date.now() + 60_000).toISOString(),
      settlement: ["transfer"],
      memoHash: normalized.required.memo ?? quoteId,
      quoteId,
      feeAtomic: "0",
      totalAtomic: normalized.required.amountAtomic,
    },
    accepts: [{
      scheme: "solana-spl",
      network: "solana-devnet",
      mint: normalized.required.settlement.mint ?? "unknown",
      maxAmount: normalized.required.amountAtomic,
      recipient: normalized.required.recipient,
      mode: "transfer",
    }],
    recommendedMode: "transfer",
    commitEndpoint: `${base.origin}/commit`,
    finalizeEndpoint: `${base.origin}/finalize`,
    receiptEndpoint: `${base.origin}/receipt/:receiptId`,
  };

  const requiredHeaderValue = headerMap["payment-required"]
    ?? headerMap["x-payment-required"]
    ?? headerMap["x-402-payment-required"];

  return {
    requirements: inferredRequirements,
    headerFlow: true,
    requiredHeaderValue,
  };
}

function chooseSettlement(
  quote: QuoteResponse,
  requirements: PaymentRequirements,
  wallet: AgentWallet,
  options: {
    preferStream: boolean;
    preferNetting: boolean;
  },
): Promise<PaymentProof> {
  const acceptsMode = (mode: "transfer" | "stream" | "netting") => requirements.accepts.some((accept) => accept.mode === mode);
  const supportsTransfer = quote.settlement.includes("transfer") && acceptsMode("transfer");
  const supportsStream = Boolean(wallet.payStream) && quote.settlement.includes("stream") && acceptsMode("stream");
  const supportsNetting = Boolean(wallet.payNetted) && quote.settlement.includes("netting") && acceptsMode("netting");
  if (options.preferStream && wallet.payStream && quote.settlement.includes("stream") && acceptsMode("stream")) {
    return wallet.payStream(quote);
  }
  if (requirements.recommendedMode === "stream" && wallet.payStream && quote.settlement.includes("stream") && acceptsMode("stream")) {
    return wallet.payStream(quote);
  }
  if (requirements.recommendedMode === "netting" && wallet.payNetted && quote.settlement.includes("netting") && acceptsMode("netting")) {
    return wallet.payNetted(quote);
  }
  if (options.preferNetting && wallet.payNetted && quote.settlement.includes("netting") && acceptsMode("netting")) {
    return wallet.payNetted(quote);
  }
  if (supportsTransfer) {
    return wallet.payTransfer(quote);
  }
  if (supportsStream && wallet.payStream) {
    return wallet.payStream(quote);
  }
  if (supportsNetting && wallet.payNetted) {
    return wallet.payNetted(quote);
  }

  throw new Error(`No supported settlement mode available: offered=${quote.settlement.join(",")}`);
}

function dateKeyUtc(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function fetchQuotesByPolicy(marketBaseUrl: string, policy: MarketPolicy): Promise<MarketQuote[]> {
  const params = quoteQueryFromPolicy(policy);
  const response = await fetch(`${marketBaseUrl.replace(/\/$/, "")}/market/quotes?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Quote lookup failed: ${response.status}`);
  }
  const payload = await response.json() as { quotes: MarketQuote[] };
  return payload.quotes ?? [];
}

async function createLimitOrder(marketBaseUrl: string, policy: MarketPolicy, timeoutMs: number): Promise<string> {
  const now = Date.now();
  const orderResponse = await fetch(`${marketBaseUrl.replace(/\/$/, "")}/market/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      capability: policy.capability,
      maxPrice: Math.round(policy.fallback?.waitUntilPrice ?? policy.maxPrice ?? policy.budget?.maxPerCall ?? Number.MAX_SAFE_INTEGER).toString(10),
      maxLatencyMs: policy.maxLatencyMs,
      expiresAt: new Date(now + timeoutMs).toISOString(),
      preferSettlement: policy.settlement?.preferStream ? "stream" : undefined,
    }),
  });
  if (!orderResponse.ok) {
    throw new Error(`Limit order creation failed: ${orderResponse.status}`);
  }
  const order = await orderResponse.json() as { orderId: string };
  return order.orderId;
}

async function waitForOrderExecution(marketBaseUrl: string, orderId: string, timeoutMs: number): Promise<MarketOrder | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await fetch(`${marketBaseUrl.replace(/\/$/, "")}/market/orders/poll`, { method: "POST" });
    const statusResponse = await fetch(`${marketBaseUrl.replace(/\/$/, "")}/market/orders/${orderId}`);
    if (!statusResponse.ok) {
      break;
    }
    const order = await statusResponse.json() as MarketOrder;
    if (order.status === "executed") {
      return order;
    }
    if (order.status === "expired" || order.status === "cancelled") {
      return order;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return undefined;
}

export async function fetchWith402(url: string, options: FetchWith402Options): Promise<FetchWith402Result> {
  const {
    wallet,
    maxSpendAtomic,
    maxPriceAtomic,
    maxSpendPerDayAtomic,
    preferStream = false,
    preferNetting = false,
    proofHeaderStyle = "PAYMENT-SIGNATURE",
    receiptStore,
    spendTracker = new InMemorySpendTracker(),
    headers,
    ...fetchOptions
  } = options;

  const firstResponse = await fetch(url, {
    ...fetchOptions,
    headers,
  });

  if (firstResponse.status !== 402) {
    return { response: firstResponse };
  }

  let firstPayload: unknown;
  const firstContentType = firstResponse.headers.get("content-type") ?? "";
  if (firstContentType.includes("application/json")) {
    try {
      firstPayload = await firstResponse.clone().json();
    } catch {
      firstPayload = undefined;
    }
  } else {
    try {
      const raw = await firstResponse.clone().text();
      firstPayload = raw ? JSON.parse(raw) : undefined;
    } catch {
      firstPayload = undefined;
    }
  }
  const parsed402 = parsePaymentRequirements(firstPayload, firstResponse.headers, url);
  const requirements = parsed402.requirements;
  const maxSpend = parseAtomic(maxSpendAtomic);
  const quoteTotal = parseAtomic(requirements.quote.totalAtomic);
  if (maxPriceAtomic) {
    const maxPrice = parseAtomic(maxPriceAtomic);
    if (quoteTotal > maxPrice) {
      throw new Error(`Quote total ${quoteTotal.toString()} exceeds maxPrice ${maxPrice.toString()}`);
    }
  }

  if (quoteTotal > maxSpend) {
    throw new Error(`Required spend ${quoteTotal.toString()} exceeds max ${maxSpend.toString()}`);
  }

  if (maxSpendPerDayAtomic) {
    const dailyLimit = parseAtomic(maxSpendPerDayAtomic);
    const key = dateKeyUtc();
    const spent = await spendTracker.getSpentForDateAtomic(key);
    if (spent + quoteTotal > dailyLimit) {
      throw new Error(`Daily spend limit exceeded: ${spent.toString()} + ${quoteTotal.toString()} > ${dailyLimit.toString()}`);
    }
  }

  const paymentProof = await chooseSettlement(requirements.quote, requirements, wallet, {
    preferStream,
    preferNetting,
  });
  const proofHeader = proofHeaderName(proofHeaderStyle);
  const encodedProof = encodeCanonicalProofHeader(toCanonicalProof(paymentProof));

  if (parsed402.headerFlow) {
    const retryResponse = await fetch(url, {
      ...fetchOptions,
      headers: {
        ...(headers ?? {}),
        [proofHeader]: encodedProof,
        ...(parsed402.requiredHeaderValue ? { "PAYMENT-REQUIRED": parsed402.requiredHeaderValue } : {}),
      },
    });
    const headerReceipt = await extractAndVerifyHeaderReceipt(retryResponse, {
      requestUrl: url,
      method: (fetchOptions.method ?? "GET").toUpperCase(),
      body: fetchOptions.body,
      recipient: requirements.quote.recipient,
      mint: requirements.quote.mint,
      totalAtomic: requirements.quote.totalAtomic,
      settlement: paymentProof.settlement,
    });
    const embeddedReceipt = headerReceipt ?? await extractAndVerifyEmbeddedReceipt(retryResponse, {
      requestUrl: url,
      method: (fetchOptions.method ?? "GET").toUpperCase(),
      body: fetchOptions.body,
      recipient: requirements.quote.recipient,
      mint: requirements.quote.mint,
      totalAtomic: requirements.quote.totalAtomic,
      settlement: paymentProof.settlement,
    });
    if (embeddedReceipt && receiptStore) {
      await receiptStore.save(embeddedReceipt);
    }

    if (maxSpendPerDayAtomic) {
      await spendTracker.addSpendForDateAtomic(dateKeyUtc(), quoteTotal);
    }

    return {
      response: retryResponse,
      receipt: headerReceipt ?? embeddedReceipt,
      paymentRequirements: requirements,
    };
  }

  const payerCommitment32B = normalizeCommitment32B(
    options.payerCommitment32B ?? `0x${crypto.randomBytes(32).toString("hex")}`,
  );

  const commitRes = await fetch(absolute(url, requirements.commitEndpoint), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      quoteId: requirements.quote.quoteId,
      payerCommitment32B,
    }),
  });

  if (!commitRes.ok) {
    throw new Error(`Commit failed with ${commitRes.status}`);
  }

  const commitData = (await commitRes.json()) as { commitId: string };

  const finalizeRes = await fetch(absolute(url, requirements.finalizeEndpoint), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [proofHeader]: encodedProof,
      ...(parsed402.requiredHeaderValue ? { "PAYMENT-REQUIRED": parsed402.requiredHeaderValue } : {}),
    },
    body: JSON.stringify({
      commitId: commitData.commitId,
      paymentProof,
    }),
  });

  if (!finalizeRes.ok) {
    const errText = await finalizeRes.text();
    throw new Error(`Finalize failed: ${finalizeRes.status} ${errText}`);
  }

  const finalizeData = (await finalizeRes.json()) as FinalizeResponse;

  const receiptRes = await fetch(absolute(url, requirements.receiptEndpoint.replace(":receiptId", finalizeData.receiptId)));
  if (!receiptRes.ok) {
    throw new Error(`Receipt fetch failed: ${receiptRes.status}`);
  }
  const receipt = (await receiptRes.json()) as SignedReceipt;
  const finalizeRequestBody = {
    commitId: commitData.commitId,
    paymentProof,
  };
  assertReceiptIntegrity(receipt, {
    quoteId: requirements.quote.quoteId,
    commitId: commitData.commitId,
    payerCommitment32B,
    recipient: requirements.quote.recipient,
    mint: requirements.quote.mint,
    totalAtomic: requirements.quote.totalAtomic,
    settlement: paymentProof.settlement,
  });
  const finalizeRequestDigest = computeRequestDigest({
    method: "POST",
    path: requestTargetFromUrl(absolute(url, requirements.finalizeEndpoint)),
    body: finalizeRequestBody,
  });
  const finalizeResponseDigest = computeResponseDigest({
    status: finalizeRes.status,
    body: finalizeData,
  });
  const receiptMatchesFinalizeHandshake =
    receipt.payload.requestDigest === finalizeRequestDigest
    && receipt.payload.responseDigest === finalizeResponseDigest;
  if (!isReceiptBoundRoute(new URL(url).pathname) && !receiptMatchesFinalizeHandshake) {
    if (receipt.payload.requestDigest !== finalizeRequestDigest) {
      throw new Error("Receipt verification failed: request digest mismatch");
    }
    throw new Error("Receipt verification failed: response digest mismatch");
  }

  const retryResponse = await fetch(url, {
    ...fetchOptions,
    headers: {
      ...(headers ?? {}),
      "x-dnp-commit-id": commitData.commitId,
    },
  });
  const headerReceipt = await extractAndVerifyHeaderReceipt(retryResponse, {
    requestUrl: url,
    method: (fetchOptions.method ?? "GET").toUpperCase(),
    body: fetchOptions.body,
    quoteId: requirements.quote.quoteId,
    commitId: commitData.commitId,
    payerCommitment32B,
    recipient: requirements.quote.recipient,
    mint: requirements.quote.mint,
    totalAtomic: requirements.quote.totalAtomic,
    settlement: paymentProof.settlement,
  });
  const embeddedReceipt = headerReceipt ?? await extractAndVerifyEmbeddedReceipt(retryResponse, {
    requestUrl: url,
    method: (fetchOptions.method ?? "GET").toUpperCase(),
    body: fetchOptions.body,
    quoteId: requirements.quote.quoteId,
    commitId: commitData.commitId,
    payerCommitment32B,
    recipient: requirements.quote.recipient,
    mint: requirements.quote.mint,
    totalAtomic: requirements.quote.totalAtomic,
    settlement: paymentProof.settlement,
  });
  if (!headerReceipt && !embeddedReceipt) {
    await assertDeliveredResponseIntegrity(retryResponse, receipt, {
      url,
      method: (fetchOptions.method ?? "GET").toUpperCase(),
      body: fetchOptions.body,
    });
  }
  if (receiptStore) {
    await receiptStore.save(receipt);
    if (embeddedReceipt && embeddedReceipt.payload.receiptId !== receipt.payload.receiptId) {
      await receiptStore.save(embeddedReceipt);
    }
  }
  if (maxSpendPerDayAtomic) {
    await spendTracker.addSpendForDateAtomic(dateKeyUtc(), quoteTotal);
  }

  return {
    response: retryResponse,
    commitId: commitData.commitId,
    receipt: headerReceipt ?? embeddedReceipt ?? receipt,
    paymentRequirements: requirements,
  };
}

export async function marketCall(options: MarketCallOptions): Promise<MarketCallResult> {
  const policy = marketPolicySchema.parse(options.marketPolicy);
  const marketBaseUrl = options.marketBaseUrl.replace(/\/$/, "");
  const resourceBaseUrl = (options.resourceBaseUrl ?? options.marketBaseUrl).replace(/\/$/, "");

  let quotes = await fetchQuotesByPolicy(marketBaseUrl, policy);
  let selectedQuote = selectQuoteByPolicy(quotes, policy);
  let orderId: string | undefined;

  if (!selectedQuote && policy.fallback?.waitUntilPrice) {
    const timeoutMs = policy.fallback.timeoutMs ?? 30_000;
    orderId = await createLimitOrder(marketBaseUrl, policy, timeoutMs);
    const executed = await waitForOrderExecution(marketBaseUrl, orderId, timeoutMs);
    if (executed?.chosenQuote) {
      selectedQuote = executed.chosenQuote;
    }
  }

  if (!selectedQuote) {
    if (policy.fallback?.routeNext) {
      quotes = await fetchQuotesByPolicy(marketBaseUrl, {
        ...policy,
        maxPrice: undefined,
        maxLatencyMs: undefined,
      });
      selectedQuote = selectQuoteByPolicy(quotes, {
        ...policy,
        maxPrice: undefined,
        maxLatencyMs: undefined,
      });
    }
  }

  if (!selectedQuote) {
    throw new Error("No quote satisfies market policy");
  }

  const executionUrl = selectedQuote.path.startsWith("http://") || selectedQuote.path.startsWith("https://")
    ? selectedQuote.path
    : `${resourceBaseUrl}${selectedQuote.path.startsWith("/") ? selectedQuote.path : `/${selectedQuote.path}`}`;

  const maxPerCall = policy.budget?.maxPerCall;
  const maxSpendAtomic = options.maxSpendAtomic
    ?? (maxPerCall ? Math.round(maxPerCall).toString(10) : selectedQuote.price);

  const result = await fetchWith402(executionUrl, {
    ...options,
    maxSpendAtomic,
    maxPriceAtomic: policy.maxPrice ? Math.round(policy.maxPrice).toString(10) : options.maxSpendAtomic,
    maxSpendPerDayAtomic: policy.budget?.maxPerDay ? Math.round(policy.budget.maxPerDay).toString(10) : undefined,
    preferStream: policy.settlement?.preferStream ?? false,
  });

  return {
    ...result,
    selectedQuote,
    provider: {
      shopId: selectedQuote.shopId,
      endpointId: selectedQuote.endpointId,
      path: selectedQuote.path,
    },
    orderId,
  };
}
