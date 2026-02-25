import crypto from "node:crypto";
import bs58 from "bs58";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  createMint,
  createTransferCheckedInstruction,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { createSignedManifest } from "../../src/market/manifest.js";
import { createSignedBundleManifest } from "../../src/market/bundles.js";
import { parseAtomic } from "../../src/feePolicy.js";
import { verifySignedReceipt } from "../../src/receipts.js";
import { encodeCanonicalProofHeader } from "../../src/x402/compat/parse.js";
import { SignedReceipt } from "../../src/types.js";
import { EphemeralAgentWallet } from "./walletFactory.js";
import { withRpcRetry } from "./retry.js";

export interface GauntletEvent {
  ts: string;
  scenario: string;
  type: string;
  ok: boolean;
  details?: Record<string, unknown>;
}

export interface ScenarioContext {
  baseUrl: string;
  connection: Connection;
  mint: PublicKey;
  mintDecimals: number;
  recipientOwner: PublicKey;
  recipientAta: PublicKey;
  funder: Keypair;
  wallets: EphemeralAgentWallet[];
  walletAtas: Map<string, PublicKey>;
  logEvent: (event: GauntletEvent) => void;
}

export interface FlowResult {
  ok: boolean;
  apiLatencyMs: number;
  chainConfirmMs?: number;
  anchorConfirmMs?: number;
  endToEndMs: number;
  latencyMs: number;
  receipt?: SignedReceipt;
  receiptId?: string;
  commitId?: string;
  txSignature?: string;
  anchorSignature?: string;
  status?: number;
  errorCode?: string;
  body?: unknown;
}

interface QuoteLike {
  quoteId: string;
  totalAtomic: string;
  amountAtomic: string;
  recipient: string;
  mint: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; headers: Headers; body: any }> {
  const response = await fetch(url, init);
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return {
    status: response.status,
    headers: response.headers,
    body,
  };
}

function secretBase58(keypair: Keypair): string {
  return bs58.encode(Buffer.from(keypair.secretKey));
}

async function ensureAta(
  connection: Connection,
  funder: Keypair,
  mint: PublicKey,
  owner: PublicKey,
): Promise<PublicKey> {
  const ata = await withRpcRetry("ensureAta", () => getOrCreateAssociatedTokenAccount(
    connection,
    funder,
    mint,
    owner,
    false,
    "confirmed",
    { commitment: "confirmed", preflightCommitment: "confirmed" },
  ));
  return ata.address;
}

export async function transferToken(params: {
  connection: Connection;
  owner: Keypair;
  ownerAta: PublicKey;
  recipientAta: PublicKey;
  mint: PublicKey;
  mintDecimals: number;
  amountAtomic: bigint;
}): Promise<string> {
  const latest = await withRpcRetry("getLatestBlockhash", () => params.connection.getLatestBlockhash("confirmed"));
  const tx = new Transaction({
    feePayer: params.owner.publicKey,
    recentBlockhash: latest.blockhash,
  }).add(createTransferCheckedInstruction(
    params.ownerAta,
    params.mint,
    params.recipientAta,
    params.owner.publicKey,
    Number(params.amountAtomic),
    params.mintDecimals,
  ));
  const signature = await withRpcRetry("sendAndConfirmTransaction:transfer", () => sendAndConfirmTransaction(
    params.connection,
    tx,
    [params.owner],
    {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    },
  ));
  return signature;
}

export async function registerSellerShops(context: ScenarioContext): Promise<string[]> {
  const sellers = context.wallets.filter((wallet) => wallet.role === "seller");
  const registered: string[] = [];
  let price = 900;
  for (const seller of sellers) {
    const shopId = `${seller.agentId}-shop`;
    const manifest = {
      manifestVersion: "market-v1" as const,
      shopId,
      name: `${seller.agentId} tools`,
      ownerPubkey: seller.pubkey.toBase58(),
      description: "safe gauntlet shop",
      category: "ai_inference",
      endpoints: [
        {
          endpointId: `${shopId}-inference`,
          method: "GET" as const,
          path: "/resource",
          capabilityTags: ["inference"],
          description: "inference unit",
          pricingModel: { kind: "flat" as const, amountAtomic: String(price) },
          settlementModes: ["transfer", "stream", "netting"] as const,
          sla: { maxLatencyMs: 1500, availabilityTarget: 0.99 },
        },
        {
          endpointId: `${shopId}-enrich`,
          method: "GET" as const,
          path: "/resource",
          capabilityTags: ["data_enrichment"],
          description: "data enrichment",
          pricingModel: { kind: "flat" as const, amountAtomic: String(price + 120) },
          settlementModes: ["transfer", "netting"] as const,
          sla: { maxLatencyMs: 1700, availabilityTarget: 0.98 },
        },
      ],
    };
    const signed = createSignedManifest(manifest, secretBase58(seller.keypair));
    const response = await fetchJson(`${context.baseUrl}/market/shops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signed),
    });
    if (response.status !== 201) {
      throw new Error(`shop register failed for ${shopId}: ${response.status}`);
    }
    registered.push(shopId);
    context.logEvent({
      ts: nowIso(),
      scenario: "S0",
      type: "shop_registered",
      ok: true,
      details: { shopId },
    });
    const heartbeat = await fetchJson(`${context.baseUrl}/market/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shopId,
        inflight: 0,
        queueDepth: 0,
        p95LatencyMs: 800 + Math.floor(Math.random() * 200),
        errorRate: 0.01,
      }),
    });
    if (heartbeat.status !== 200) {
      throw new Error(`heartbeat failed for ${shopId}`);
    }
    price += 75;
  }
  return registered;
}

export async function registerBundle(context: ScenarioContext, sellerShopIds: string[]): Promise<string> {
  const owner = context.wallets.find((wallet) => wallet.role === "bot");
  if (!owner) {
    throw new Error("missing bot wallet for bundle owner");
  }
  const bundleId = `bundle-${Date.now()}`;
  const bundle = {
    bundleId,
    ownerPubkey: owner.pubkey.toBase58(),
    name: "gauntlet-bundle",
    steps: [
      { capability: "inference", constraints: { maxPriceAtomic: "3000", maxLatencyMs: 2500 } },
      { capability: "data_enrichment", constraints: { maxPriceAtomic: "3500", maxLatencyMs: 3000 } },
    ],
    bundlePriceModel: { kind: "flat" as const, amountAtomic: "4000" },
    marginPolicy: { kind: "fixed_atomic" as const, value: "250" },
    examples: [`curl ${context.baseUrl}/market/bundles/${bundleId}/run`],
  };
  const signed = createSignedBundleManifest(bundle, secretBase58(owner.keypair));
  const created = await fetchJson(`${context.baseUrl}/market/bundles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(signed),
  });
  if (created.status !== 201) {
    throw new Error(`bundle creation failed: ${created.status}`);
  }
  const run = await fetchJson(`${context.baseUrl}/market/bundles/${bundleId}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "gauntlet", shops: sellerShopIds }),
  });
  if (run.status !== 200) {
    throw new Error(`bundle run failed: ${run.status}`);
  }
  return bundleId;
}

async function getQuoteFromResource(baseUrl: string, resourcePath: string): Promise<{
  requiredHeader: string;
  quote: QuoteLike;
  commitEndpoint: string;
  finalizeEndpoint: string;
  receiptEndpoint: string;
}> {
  const first = await fetchJson(`${baseUrl}${resourcePath}`);
  if (first.status !== 402) {
    throw new Error(`expected 402 for ${resourcePath}, got ${first.status}`);
  }
  const requiredHeader = first.headers.get("payment-required");
  const paymentRequirements = first.body?.paymentRequirements;
  if (!requiredHeader || !paymentRequirements?.quote?.quoteId) {
    throw new Error("missing payment required header or quote");
  }
  return {
    requiredHeader,
    quote: {
      quoteId: paymentRequirements.quote.quoteId,
      totalAtomic: paymentRequirements.quote.totalAtomic,
      amountAtomic: paymentRequirements.quote.amount,
      recipient: paymentRequirements.quote.recipient,
      mint: paymentRequirements.quote.mint,
    },
    commitEndpoint: paymentRequirements.commitEndpoint,
    finalizeEndpoint: paymentRequirements.finalizeEndpoint,
    receiptEndpoint: paymentRequirements.receiptEndpoint,
  };
}

async function commitQuote(baseUrl: string, quoteId: string): Promise<string> {
  const commit = await fetchJson(`${baseUrl}/commit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteId,
      payerCommitment32B: `0x${crypto.randomBytes(32).toString("hex")}`,
    }),
  });
  if (commit.status !== 201) {
    throw new Error(`commit failed: ${commit.status}`);
  }
  return commit.body.commitId;
}

export async function runPayFlow(params: {
  context: ScenarioContext;
  buyer: EphemeralAgentWallet;
  resourcePath?: "/resource" | "/inference";
  settlement: "transfer" | "stream" | "netting";
  proofHeaderStyle?: "PAYMENT-SIGNATURE" | "X-PAYMENT";
  overrideAmountAtomic?: bigint;
  underpayByAtomic?: bigint;
  wrongRecipientOwner?: PublicKey;
  wrongMint?: PublicKey;
  waitForAnchor?: boolean;
}): Promise<FlowResult> {
  const started = Date.now();
  try {
    const resourcePath = params.resourcePath ?? "/resource";
    const details = await getQuoteFromResource(params.context.baseUrl, resourcePath);
    const commitId = await commitQuote(params.context.baseUrl, details.quote.quoteId);
    const quoteTotal = parseAtomic(details.quote.totalAtomic);

    const amountToPay = params.overrideAmountAtomic ?? (
      params.underpayByAtomic && params.underpayByAtomic > 0n
        ? (quoteTotal > params.underpayByAtomic ? quoteTotal - params.underpayByAtomic : 0n)
        : quoteTotal
    );
    const mint = params.wrongMint ?? params.context.mint;
    const ownerAta = mint.equals(params.context.mint)
      ? params.context.walletAtas.get(params.buyer.agentId)
      : (await ensureAta(params.context.connection, params.context.funder, mint, params.buyer.pubkey));
    if (!ownerAta) {
      throw new Error(`missing buyer ATA for ${params.buyer.agentId}`);
    }
    const recipientOwner = params.wrongRecipientOwner ?? params.context.recipientOwner;
    const recipientAta = await ensureAta(params.context.connection, params.context.funder, mint, recipientOwner);

    let paymentProof: Record<string, unknown>;
    let txSignature: string | undefined;
    let chainConfirmMs: number | undefined;
    if (params.settlement === "netting") {
      paymentProof = { settlement: "netting", amountAtomic: amountToPay.toString(10), note: "gauntlet-netting" };
    } else if (params.settlement === "stream") {
      const chainStart = Date.now();
      txSignature = await transferToken({
        connection: params.context.connection,
        owner: params.buyer.keypair,
        ownerAta,
        recipientAta,
        mint,
        mintDecimals: params.context.mintDecimals,
        amountAtomic: amountToPay,
      });
      chainConfirmMs = Date.now() - chainStart;
      paymentProof = {
        settlement: "stream",
        streamId: `stream-${params.buyer.agentId}-${Date.now()}`,
        amountAtomic: amountToPay.toString(10),
        topupSignature: txSignature,
      };
    } else {
      const chainStart = Date.now();
      txSignature = await transferToken({
        connection: params.context.connection,
        owner: params.buyer.keypair,
        ownerAta,
        recipientAta,
        mint,
        mintDecimals: params.context.mintDecimals,
        amountAtomic: amountToPay,
      });
      chainConfirmMs = Date.now() - chainStart;
      paymentProof = {
        settlement: "transfer",
        txSignature,
        amountAtomic: amountToPay.toString(10),
      };
    }

    const canonicalProof = encodeCanonicalProofHeader({
      version: "x402-proof-v1",
      scheme: params.settlement === "transfer" ? "solana_spl" : "unknown",
      txSig: txSignature,
      proofBlob: params.settlement === "transfer" ? undefined : JSON.stringify(paymentProof),
      raw: { headers: {} },
      amountAtomic: amountToPay.toString(10),
    });
    const proofHeader = params.proofHeaderStyle === "X-PAYMENT" ? "X-PAYMENT" : "PAYMENT-SIGNATURE";
    const finalize = await fetchJson(`${params.context.baseUrl}/finalize`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [proofHeader]: canonicalProof,
        "PAYMENT-REQUIRED": details.requiredHeader,
      },
      body: JSON.stringify({
        commitId,
        paymentProof,
      }),
    });

    if (finalize.status !== 200) {
      const elapsed = Date.now() - started;
      return {
        ok: false,
        apiLatencyMs: elapsed,
        chainConfirmMs,
        endToEndMs: elapsed,
        latencyMs: elapsed,
        status: finalize.status,
        errorCode: finalize.body?.error?.code,
        body: finalize.body,
        commitId,
        txSignature,
      };
    }

    const receiptId = finalize.body?.receiptId as string | undefined;
    if (!receiptId) {
      throw new Error("finalize missing receiptId");
    }
    const receiptRes = await fetchJson(`${params.context.baseUrl}/receipt/${receiptId}`);
    if (receiptRes.status !== 200 || !verifySignedReceipt(receiptRes.body as SignedReceipt)) {
      throw new Error("receipt verification failed");
    }
    const retry = await fetchJson(`${params.context.baseUrl}${resourcePath}`, {
      headers: { "x-dnp-commit-id": commitId },
    });
    if (retry.status !== 200) {
      throw new Error(`retry expected 200 got ${retry.status}`);
    }
    const apiDoneAt = Date.now();
    const apiLatencyMs = apiDoneAt - started;

    let anchorConfirmMs: number | undefined;
    const anchorStart = Date.now();
    const anchorLookup = params.waitForAnchor === false
      ? { ok: false, signature: undefined }
      : await waitForAnchor(params.context.baseUrl, receiptId, 120_000);
    if (params.waitForAnchor !== false) {
      anchorConfirmMs = Date.now() - anchorStart;
    }
    const endToEndMs = Date.now() - started;
    return {
      ok: true,
      apiLatencyMs,
      chainConfirmMs,
      anchorConfirmMs,
      endToEndMs,
      latencyMs: endToEndMs,
      receipt: receiptRes.body as SignedReceipt,
      receiptId,
      commitId,
      txSignature,
      anchorSignature: anchorLookup.signature,
      status: 200,
    };
  } catch (error) {
    const elapsed = Date.now() - started;
    return {
      ok: false,
      apiLatencyMs: elapsed,
      endToEndMs: elapsed,
      latencyMs: elapsed,
      body: { error: String(error) },
    };
  }
}

export async function runCompatReplayScenario(params: {
  context: ScenarioContext;
  buyer: EphemeralAgentWallet;
}): Promise<{ ok: boolean; firstStatus: number; secondStatus: number; secondCode?: string; sample?: unknown }> {
  const details = await getQuoteFromResource(params.context.baseUrl, "/resource");
  const ownerAta = params.context.walletAtas.get(params.buyer.agentId);
  if (!ownerAta) {
    throw new Error("missing buyer ATA");
  }
  const txSignature = await transferToken({
    connection: params.context.connection,
    owner: params.buyer.keypair,
    ownerAta,
    recipientAta: params.context.recipientAta,
    mint: params.context.mint,
    mintDecimals: params.context.mintDecimals,
    amountAtomic: parseAtomic(details.quote.totalAtomic),
  });

  const encodedProof = encodeCanonicalProofHeader({
    version: "x402-proof-v1",
    scheme: "solana_spl",
    txSig: txSignature,
    amountAtomic: details.quote.totalAtomic,
    raw: { headers: {} },
  });

  const firstRetry = await fetchJson(`${params.context.baseUrl}/resource`, {
    headers: {
      "PAYMENT-REQUIRED": details.requiredHeader,
      "PAYMENT-SIGNATURE": encodedProof,
    },
  });

  const secondRequired = await getQuoteFromResource(params.context.baseUrl, "/resource");
  const secondRetry = await fetchJson(`${params.context.baseUrl}/resource`, {
    headers: {
      "PAYMENT-REQUIRED": secondRequired.requiredHeader,
      "X-PAYMENT": encodedProof,
    },
  });

  return {
    ok: firstRetry.status === 200 && secondRetry.status === 409 && secondRetry.body?.error?.code === "X402_REPLAY_DETECTED",
    firstStatus: firstRetry.status,
    secondStatus: secondRetry.status,
    secondCode: secondRetry.body?.error?.code,
    sample: secondRetry.body,
  };
}

export async function runOrderScenario(baseUrl: string): Promise<{
  executedOrderId?: string;
  cancelledOrderId?: string;
}> {
  const created = await fetchJson(`${baseUrl}/market/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      capability: "inference",
      maxPrice: "5000",
      maxLatencyMs: 2500,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  });
  if (created.status !== 201) {
    throw new Error(`order create failed: ${created.status}`);
  }
  const orderId = created.body.orderId as string;
  for (let i = 0; i < 20; i += 1) {
    await fetchJson(`${baseUrl}/market/orders/poll`, { method: "POST" });
    const state = await fetchJson(`${baseUrl}/market/orders/${orderId}`);
    if (state.status === 200 && state.body.status === "executed") {
      const cancelCandidate = await fetchJson(`${baseUrl}/market/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capability: "inference",
          maxPrice: "1",
          maxLatencyMs: 1500,
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
        }),
      });
      if (cancelCandidate.status !== 201) {
        throw new Error("cancel candidate order create failed");
      }
      const cancelId = cancelCandidate.body.orderId as string;
      const cancelled = await fetchJson(`${baseUrl}/market/orders/${cancelId}/cancel`, { method: "POST" });
      if (cancelled.status !== 200) {
        throw new Error("order cancel failed");
      }
      return {
        executedOrderId: orderId,
        cancelledOrderId: cancelId,
      };
    }
    await sleep(500);
  }
  throw new Error("order did not execute in expected window");
}

export async function waitForAnchor(baseUrl: string, receiptId: string, timeoutMs: number): Promise<{
  ok: boolean;
  signature?: string;
}> {
  const deadline = Date.now() + timeoutMs;
  let waitMs = 500;
  while (Date.now() < deadline) {
    const status = await fetchJson(`${baseUrl}/anchoring/receipt/${receiptId}`);
    if (status.status === 200 && status.body?.anchored?.signature) {
      return {
        ok: true,
        signature: status.body.anchored.signature as string,
      };
    }
    await sleep(waitMs);
    waitMs = Math.min(waitMs * 2, 8_000);
  }
  return { ok: false };
}

export async function waitForAnchoredCount(baseUrl: string, minIncrease: number, baseline: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let waitMs = 500;
  while (Date.now() < deadline) {
    const status = await fetchJson(`${baseUrl}/market/anchoring/status`);
    const anchored = Number(status.body?.anchoredCount ?? 0);
    if (anchored >= baseline + minIncrease) {
      return anchored;
    }
    await sleep(waitMs);
    waitMs = Math.min(waitMs * 2, 8_000);
  }
  const final = await fetchJson(`${baseUrl}/market/anchoring/status`);
  return Number(final.body?.anchoredCount ?? baseline);
}

export async function createWrongMint(params: {
  connection: Connection;
  funder: Keypair;
  buyer: EphemeralAgentWallet;
  recipientOwner: PublicKey;
  decimals: number;
  amountAtomic: bigint;
}): Promise<{ wrongMint: PublicKey }> {
  const wrongMint = await withRpcRetry("createMint:wrongMint", () => createMint(
    params.connection,
    params.funder,
    params.funder.publicKey,
    null,
    params.decimals,
  ));
  const buyerAta = await withRpcRetry("getOrCreateATA:wrongMintBuyer", () => getOrCreateAssociatedTokenAccount(
    params.connection,
    params.funder,
    wrongMint,
    params.buyer.pubkey,
  ));
  await withRpcRetry("mintTo:wrongMintBuyer", () => mintTo(
    params.connection,
    params.funder,
    wrongMint,
    buyerAta.address,
    params.funder,
    Number(params.amountAtomic + 1_000n),
  ));
  await ensureAta(params.connection, params.funder, wrongMint, params.recipientOwner);
  return { wrongMint };
}
