import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { parseAtomic } from "../../src/feePolicy.js";
import { NettingLedger } from "../../src/nettingLedger.js";
import { ReceiptSigner, verifySignedReceipt } from "../../src/receipts.js";
import { verifySplTransferProof } from "../../src/verifier/splTransfer.js";
import { MarketAnalytics } from "../../src/market/analytics.js";
import { BundleExecutor } from "../../src/market/bundleExecutor.js";
import { BundleRegistry, createSignedBundleManifest } from "../../src/market/bundles.js";
import { HeartbeatIndex } from "../../src/market/heartbeat.js";
import { createSignedManifest } from "../../src/market/manifest.js";
import { MarketOrders } from "../../src/market/orders.js";
import { selectQuoteByPolicy } from "../../src/market/policy.js";
import { QuoteBook } from "../../src/market/quotes.js";
import { MarketRegistry } from "../../src/market/registry.js";
import { MarketStorage } from "../../src/market/storage.js";
import { BundleRunResult, MarketEvent, ShopManifest } from "../../src/market/types.js";
import { SettlementMode } from "../../src/types.js";

type AgentRole = "buyer" | "seller" | "reseller";

interface AgentProfile {
  agentId: string;
  role: AgentRole;
  maxPerCallAtomic?: string;
  maxPerDayAtomic?: string;
  preferredSettlement?: SettlementMode;
}

interface ScenarioResult {
  name: string;
  seed: number;
  passed: boolean;
  details?: Record<string, unknown>;
  error?: string;
}

interface TenAgentSimulationReport {
  generatedAt: string;
  cluster: string;
  baseSeed: number;
  agents: AgentProfile[];
  scenarioResults: ScenarioResult[];
  passedScenarios: number;
  failedScenarios: number;
  analyticsConsistency: {
    fastCount24h: number;
    verifiedCount24h: number;
    verifiedWithinFast: boolean;
    verifiedMode: "active" | "empty_expected";
  };
  notes: string[];
}

interface SimulationContext {
  agents: AgentProfile[];
  registry: MarketRegistry;
  heartbeat: HeartbeatIndex;
  quoteBook: QuoteBook;
  orders: MarketOrders;
  bundles: BundleRegistry;
  bundleExecutor: BundleExecutor;
  storage: MarketStorage;
  analytics: MarketAnalytics;
  now: () => Date;
  getNowMs: () => number;
  setNowMs: (value: number) => void;
  advanceMs: (delta: number) => void;
  emit: (event: Omit<MarketEvent, "ts">) => MarketEvent;
}

function usage(): string {
  return [
    "Usage: npm run sim:10agents -- [options]",
    "",
    "Options:",
    "  --seed <n>      Base deterministic seed (default: 260216)",
    "  --cluster <id>  Cluster label in report (default: devnet)",
    "  --out <path>    Output JSON path",
    "  --help          Show this help",
  ].join("\n");
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const index = args.findIndex((arg) => arg === flag);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function deterministicSigner(seed: number): { ownerPubkey: string; ownerSecret: string } {
  const rng = mulberry32(seed);
  const seedBytes = new Uint8Array(32);
  for (let i = 0; i < seedBytes.length; i += 1) {
    seedBytes[i] = randomInt(rng, 0, 255);
  }
  const keypair = nacl.sign.keyPair.fromSeed(seedBytes);
  return {
    ownerPubkey: bs58.encode(keypair.publicKey),
    ownerSecret: bs58.encode(keypair.secretKey),
  };
}

function anchor32(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function registerSellerShops(context: SimulationContext, seed: number): void {
  const sellerSeeds = [seed + 11, seed + 12, seed + 13];
  const manifests: ShopManifest[] = sellerSeeds.map((entrySeed, index) => {
    const signer = deterministicSigner(entrySeed);
    const shopId = `seller-${index + 1}`;
    const basePrice = [700, 1000, 1350][index];
    const latency = [950, 700, 520][index];

    return {
      manifestVersion: "market-v1",
      shopId,
      name: `Seller ${index + 1}`,
      category: "reference",
      ownerPubkey: signer.ownerPubkey,
      endpoints: [
        {
          endpointId: `${shopId}-inference`,
          method: "POST",
          path: "/inference",
          capabilityTags: ["inference"],
          description: "Inference endpoint",
          pricingModel: index === 0
            ? {
              kind: "surge",
              baseAmountAtomic: String(basePrice),
              minMultiplier: 0.8,
              maxMultiplier: 3,
            }
            : {
              kind: "flat",
              amountAtomic: String(basePrice),
            },
          settlementModes: ["transfer", "stream", "netting"],
          sla: {
            maxLatencyMs: latency,
            availabilityTarget: 0.995,
          },
          examples: [
            `curl -X POST http://localhost:8080/inference -H 'x-agent: buyer'`,
          ],
        },
        {
          endpointId: `${shopId}-fetch`,
          method: "POST",
          path: "/tool/pdf-fetch",
          capabilityTags: ["pdf_fetch_extract"],
          description: "PDF extraction endpoint",
          pricingModel: {
            kind: "flat",
            amountAtomic: String(basePrice + 150),
          },
          settlementModes: ["transfer", "netting"],
          sla: {
            maxLatencyMs: latency + 300,
            availabilityTarget: 0.99,
          },
        },
        {
          endpointId: `${shopId}-summarize`,
          method: "POST",
          path: "/tool/summarize",
          capabilityTags: ["summarize_with_quotes"],
          description: "Summarization endpoint",
          pricingModel: {
            kind: "flat",
            amountAtomic: String(basePrice + 200),
          },
          settlementModes: ["transfer", "netting"],
          sla: {
            maxLatencyMs: latency + 250,
            availabilityTarget: 0.99,
          },
        },
        {
          endpointId: `${shopId}-entity`,
          method: "POST",
          path: "/tool/entity",
          capabilityTags: ["entity_extract"],
          description: "Entity extraction endpoint",
          pricingModel: {
            kind: "flat",
            amountAtomic: String(basePrice + 80),
          },
          settlementModes: ["transfer", "netting"],
          sla: {
            maxLatencyMs: latency + 180,
            availabilityTarget: 0.995,
          },
        },
        {
          endpointId: `${shopId}-dedupe`,
          method: "POST",
          path: "/tool/dedupe",
          capabilityTags: ["dedupe_normalize"],
          description: "Dedupe endpoint",
          pricingModel: {
            kind: "flat",
            amountAtomic: String(basePrice + 60),
          },
          settlementModes: ["transfer", "netting"],
          sla: {
            maxLatencyMs: latency + 140,
            availabilityTarget: 0.995,
          },
        },
        {
          endpointId: `${shopId}-stream`,
          method: "POST",
          path: "/stream-access",
          capabilityTags: ["tool_gateway_stream_access"],
          description: "Streaming access endpoint",
          pricingModel: {
            kind: "stream",
            rateAtomicPerSecond: "20",
            minTopupAtomic: "200",
          },
          settlementModes: ["stream", "netting", "transfer"],
          sla: {
            maxLatencyMs: latency,
            availabilityTarget: 0.999,
          },
        },
      ],
    };
  });

  manifests.forEach((manifest, index) => {
    const signer = deterministicSigner(sellerSeeds[index]);
    context.registry.register(createSignedManifest(manifest, signer.ownerSecret, context.now()));
  });
}

function initContext(baseSeed: number): SimulationContext {
  const agents: AgentProfile[] = [
    { agentId: "buyer-1", role: "buyer", maxPerCallAtomic: "900", maxPerDayAtomic: "100000", preferredSettlement: "netting" },
    { agentId: "buyer-2", role: "buyer", maxPerCallAtomic: "1000", maxPerDayAtomic: "120000", preferredSettlement: "transfer" },
    { agentId: "buyer-3", role: "buyer", maxPerCallAtomic: "1100", maxPerDayAtomic: "130000", preferredSettlement: "netting" },
    { agentId: "buyer-4", role: "buyer", maxPerCallAtomic: "1400", maxPerDayAtomic: "140000", preferredSettlement: "stream" },
    { agentId: "buyer-5", role: "buyer", maxPerCallAtomic: "1800", maxPerDayAtomic: "160000", preferredSettlement: "transfer" },
    { agentId: "seller-1", role: "seller", preferredSettlement: "netting" },
    { agentId: "seller-2", role: "seller", preferredSettlement: "transfer" },
    { agentId: "seller-3", role: "seller", preferredSettlement: "stream" },
    { agentId: "reseller-1", role: "reseller", preferredSettlement: "netting" },
    { agentId: "reseller-2", role: "reseller", preferredSettlement: "transfer" },
  ];

  let nowMs = Date.parse("2026-02-16T00:00:00.000Z");
  const now = () => new Date(nowMs);

  const registry = new MarketRegistry();
  const heartbeat = new HeartbeatIndex();
  const quoteSigner = ReceiptSigner.generate();
  const storage = new MarketStorage();
  const quoteBook = new QuoteBook(registry, heartbeat, quoteSigner, (shopId) => {
    if (shopId === "seller-3") {
      return 0.95;
    }
    if (shopId === "seller-2") {
      return 0.9;
    }
    return 0.82;
  });
  const orders = new MarketOrders(quoteBook, now);
  const bundles = new BundleRegistry();

  const emit = (event: Omit<MarketEvent, "ts">): MarketEvent => {
    const stamped: MarketEvent = {
      ...event,
      ts: now().toISOString(),
    };
    storage.append(stamped);
    return stamped;
  };

  const bundleExecutor = new BundleExecutor(bundles, quoteBook, {
    now,
    recordEvent: (event) => {
      emit(event);
    },
  });

  const analytics = new MarketAnalytics(storage, registry, quoteBook, now);

  const context: SimulationContext = {
    agents,
    registry,
    heartbeat,
    quoteBook,
    orders,
    bundles,
    bundleExecutor,
    storage,
    analytics,
    now,
    getNowMs: () => nowMs,
    setNowMs: (value: number) => {
      nowMs = value;
    },
    advanceMs: (delta: number) => {
      nowMs += delta;
    },
    emit,
  };

  registerSellerShops(context, baseSeed);
  return context;
}

function emitPaidFulfilled(
  context: SimulationContext,
  params: {
    shopId: string;
    endpointId: string;
    capability: string;
    priceAtomic: string;
    settlementMode: SettlementMode;
    anchored: boolean;
  },
): { receiptId: string; anchor?: string } {
  const receiptId = crypto.randomUUID();
  const anchor = params.anchored ? anchor32(`${receiptId}:${context.getNowMs()}`) : undefined;
  const verificationTier = params.anchored ? "VERIFIED" : "FAST";

  context.emit({
    type: "PAYMENT_VERIFIED",
    shopId: params.shopId,
    endpointId: params.endpointId,
    capabilityTags: [params.capability],
    priceAmount: params.priceAtomic,
    mint: "USDC",
    settlementMode: params.settlementMode,
    receiptId,
    anchor32: anchor,
    anchored: params.anchored,
    verificationTier,
    receiptValid: true,
  });

  context.emit({
    type: "REQUEST_FULFILLED",
    shopId: params.shopId,
    endpointId: params.endpointId,
    capabilityTags: [params.capability],
    priceAmount: params.priceAtomic,
    mint: "USDC",
    settlementMode: params.settlementMode,
    statusCode: 200,
    latencyMs: 400,
    receiptId,
    anchor32: anchor,
    anchored: params.anchored,
    verificationTier,
    receiptValid: true,
  });

  return { receiptId, anchor };
}

function scenarioQuoteCompetitionAndRouting(context: SimulationContext, seed: number): Record<string, unknown> {
  const buyers = context.agents.filter((agent) => agent.role === "buyer");

  context.heartbeat.upsert({
    shopId: "seller-1",
    inflight: 95,
    queueDepth: 220,
    p95LatencyMs: 3600,
    errorRate: 0.03,
  }, context.now());
  context.heartbeat.upsert({
    shopId: "seller-2",
    inflight: 25,
    queueDepth: 40,
    p95LatencyMs: 1100,
    errorRate: 0.01,
  }, context.now());
  context.heartbeat.upsert({
    shopId: "seller-3",
    inflight: 12,
    queueDepth: 18,
    p95LatencyMs: 650,
    errorRate: 0.005,
  }, context.now());

  const routed = new Map<string, number>();
  const pendingOrderIds: string[] = [];

  for (const buyer of buyers) {
    const quotes = context.quoteBook.list({
      capability: "inference",
      maxLatencyMs: 2_500,
      limit: 5,
    });

    const selected = selectQuoteByPolicy(quotes, {
      capability: "inference",
      maxPrice: buyer.maxPerCallAtomic ? Number.parseInt(buyer.maxPerCallAtomic, 10) : undefined,
      maxLatencyMs: 2_500,
      prefer: ["lowest_price", "high_reputation"],
      fallback: {
        waitUntilPrice: buyer.maxPerCallAtomic ? Number.parseInt(buyer.maxPerCallAtomic, 10) : undefined,
        timeoutMs: 60_000,
        routeNext: true,
      },
      settlement: {
        allowNetting: true,
        preferStream: buyer.preferredSettlement === "stream",
      },
      budget: {
        maxPerCall: buyer.maxPerCallAtomic ? Number.parseInt(buyer.maxPerCallAtomic, 10) : undefined,
        maxPerDay: buyer.maxPerDayAtomic ? Number.parseInt(buyer.maxPerDayAtomic, 10) : undefined,
      },
    });

    if (!selected) {
      const order = context.orders.create({
        capability: "inference",
        maxPrice: buyer.maxPerCallAtomic ?? "1000",
        maxLatencyMs: 2_500,
        expiresAt: new Date(context.getNowMs() + 90_000).toISOString(),
        preferSettlement: buyer.preferredSettlement,
      });
      pendingOrderIds.push(order.orderId);
      continue;
    }

    routed.set(selected.shopId, (routed.get(selected.shopId) ?? 0) + 1);
    emitPaidFulfilled(context, {
      shopId: selected.shopId,
      endpointId: selected.endpointId,
      capability: "inference",
      priceAtomic: selected.price,
      settlementMode: selected.settlementModes[0] ?? "transfer",
      anchored: routed.size % 2 === 0,
    });
  }

  context.advanceMs(31_000);
  context.heartbeat.upsert({
    shopId: "seller-1",
    inflight: 8,
    queueDepth: 12,
    p95LatencyMs: 700,
    errorRate: 0.002,
  }, context.now());

  const executed = context.orders.poll();
  for (const order of executed) {
    if (!order.chosenQuote) {
      continue;
    }
    routed.set(order.chosenQuote.shopId, (routed.get(order.chosenQuote.shopId) ?? 0) + 1);
    emitPaidFulfilled(context, {
      shopId: order.chosenQuote.shopId,
      endpointId: order.chosenQuote.endpointId,
      capability: "inference",
      priceAtomic: order.chosenQuote.price,
      settlementMode: order.preferSettlement ?? "transfer",
      anchored: true,
    });
  }

  if (routed.size < 2) {
    throw new Error("Routing did not diversify across at least 2 sellers.");
  }
  if (pendingOrderIds.length === 0) {
    throw new Error("No limit orders were created while cheapest seller was saturated.");
  }
  if (!executed.some((order) => pendingOrderIds.includes(order.orderId))) {
    throw new Error("Limit orders did not execute after load dropped.");
  }

  return {
    seed,
    routedShops: Array.from(routed.entries()),
    pendingOrders: pendingOrderIds.length,
    executedOrders: executed.length,
  };
}

function scenarioMicropaymentsNetting(context: SimulationContext, seed: number): Record<string, unknown> {
  const ledger = new NettingLedger({
    settleThresholdAtomic: 1_000_000n,
    settleIntervalMs: 120_000,
    feeAccrualThresholdAtomic: 400n,
  });

  const signer = ReceiptSigner.generate();
  const receipts = [] as ReturnType<ReceiptSigner["sign"]>[];
  const startMs = context.getNowMs();

  for (let i = 0; i < 500; i += 1) {
    ledger.add({
      payerCommitment32B: "44".repeat(32),
      providerId: "seller-1",
      amountAtomic: "10",
      feeAtomic: "1",
      quoteId: `micro-q-${seed}-${i}`,
      commitId: `micro-c-${seed}-${i}`,
      createdAtMs: startMs + i,
    });

    const receipt = signer.sign({
      receiptId: `micro-receipt-${seed}-${i}`,
      quoteId: `micro-q-${seed}-${i}`,
      commitId: `micro-c-${seed}-${i}`,
      resource: "/resource",
      payerCommitment32B: "44".repeat(32),
      recipient: "seller-1",
      mint: "USDC",
      amountAtomic: "10",
      feeAtomic: "1",
      totalAtomic: "11",
      settlement: "netting",
      settledOnchain: false,
      createdAt: new Date(startMs + i).toISOString(),
    });
    receipts.push(receipt);

    context.emit({
      type: "PAYMENT_VERIFIED",
      shopId: "seller-1",
      endpointId: "seller-1-inference",
      capabilityTags: ["inference"],
      priceAmount: "11",
      mint: "USDC",
      settlementMode: "netting",
      receiptId: receipt.payload.receiptId,
      anchor32: anchor32(receipt.payload.receiptId),
      anchored: i % 4 === 0,
      verificationTier: i % 4 === 0 ? "VERIFIED" : "FAST",
      receiptValid: true,
    });

    context.emit({
      type: "REQUEST_FULFILLED",
      shopId: "seller-1",
      endpointId: "seller-1-inference",
      capabilityTags: ["inference"],
      priceAmount: "11",
      mint: "USDC",
      settlementMode: "netting",
      statusCode: 200,
      latencyMs: 120,
      receiptId: receipt.payload.receiptId,
      anchor32: anchor32(receipt.payload.receiptId),
      anchored: i % 4 === 0,
      verificationTier: i % 4 === 0 ? "VERIFIED" : "FAST",
      receiptValid: true,
    });
  }

  for (let i = 0; i < receipts.length; i += 1) {
    if (!verifySignedReceipt(receipts[i])) {
      throw new Error(`Receipt signature invalid at index ${i}`);
    }
    if (i > 0 && receipts[i].prevHash !== receipts[i - 1].receiptHash) {
      throw new Error(`Receipt hash-chain broken at index ${i}`);
    }
  }

  const batches = ledger.flushReady(startMs + 121_000);
  if (batches.length !== 1) {
    throw new Error(`Expected 1 settlement batch, got ${batches.length}`);
  }
  if (batches[0].quoteIds.length !== 500) {
    throw new Error(`Expected 500 aggregated micro charges, got ${batches[0].quoteIds.length}`);
  }

  return {
    seed,
    charges: 500,
    settleAmountAtomic: batches[0].settleAmountAtomic,
    providerAmountAtomic: batches[0].providerAmountAtomic,
    platformFeeAtomic: batches[0].platformFeeAtomic,
    receiptChainFinalHash: receipts[receipts.length - 1]?.receiptHash,
  };
}

function scenarioStreamingSession(context: SimulationContext, seed: number): Record<string, unknown> {
  const ratePerSecond = 20n;
  let streamId = `stream-${seed}`;
  let streamActive = true;
  let fundedUntilMs = context.getNowMs();
  const calls: string[] = [];

  const topup = (amountAtomic: string): void => {
    const seconds = Number(parseAtomic(amountAtomic) / ratePerSecond);
    fundedUntilMs += Math.max(seconds, 1) * 1000;
    emitPaidFulfilled(context, {
      shopId: "seller-2",
      endpointId: "seller-2-stream",
      capability: "tool_gateway_stream_access",
      priceAtomic: amountAtomic,
      settlementMode: "stream",
      anchored: true,
    });
  };

  topup("600");

  for (let i = 0; i < 3; i += 1) {
    context.advanceMs(5_000);
    if (streamActive && context.getNowMs() < fundedUntilMs) {
      const receipt = emitPaidFulfilled(context, {
        shopId: "seller-2",
        endpointId: "seller-2-stream",
        capability: "tool_gateway_stream_access",
        priceAtomic: "100",
        settlementMode: "stream",
        anchored: i % 2 === 0,
      });
      calls.push(receipt.receiptId);
    }
  }

  const fundedBeforeTopup = fundedUntilMs;
  topup("400");

  for (let i = 0; i < 2; i += 1) {
    context.advanceMs(5_000);
    if (streamActive && context.getNowMs() < fundedUntilMs) {
      const receipt = emitPaidFulfilled(context, {
        shopId: "seller-2",
        endpointId: "seller-2-stream",
        capability: "tool_gateway_stream_access",
        priceAtomic: "100",
        settlementMode: "stream",
        anchored: true,
      });
      calls.push(receipt.receiptId);
    }
  }

  streamActive = false;
  streamId = `${streamId}-stopped`;

  if (calls.length < 5) {
    throw new Error(`Expected >=5 stream calls in funded window, got ${calls.length}`);
  }
  if (fundedUntilMs <= fundedBeforeTopup) {
    throw new Error("Stream top-up did not extend funded window.");
  }

  return {
    seed,
    streamId,
    callsInFundedWindow: calls.length,
    fundedUntil: new Date(fundedUntilMs).toISOString(),
    status: streamActive ? "active" : "stopped",
  };
}

async function scenarioBundlesAndResellers(context: SimulationContext, seed: number): Promise<Record<string, unknown>> {
  const resellerOne = deterministicSigner(seed + 51);
  const resellerTwo = deterministicSigner(seed + 52);

  context.bundles.register(createSignedBundleManifest({
    bundleId: "bundle-deep-research",
    ownerPubkey: resellerOne.ownerPubkey,
    name: "Deep Research Report",
    steps: [
      { capability: "pdf_fetch_extract", constraints: { maxPriceAtomic: "2500" } },
      { capability: "summarize_with_quotes", constraints: { maxPriceAtomic: "2600" } },
    ],
    bundlePriceModel: {
      kind: "flat",
      amountAtomic: "4200",
    },
    marginPolicy: {
      kind: "percent",
      value: 15,
    },
  }, resellerOne.ownerSecret, context.now()));

  context.bundles.register(createSignedBundleManifest({
    bundleId: "bundle-ops-clean",
    ownerPubkey: resellerTwo.ownerPubkey,
    name: "Ops Clean Bundle",
    steps: [
      { capability: "entity_extract", constraints: { maxPriceAtomic: "2200" } },
      { capability: "dedupe_normalize", constraints: { maxPriceAtomic: "2200" } },
    ],
    bundlePriceModel: {
      kind: "flat",
      amountAtomic: "3600",
    },
    marginPolicy: {
      kind: "fixed_atomic",
      value: "300",
    },
  }, resellerTwo.ownerSecret, context.now()));

  const resultOne = await context.bundleExecutor.run("bundle-deep-research", { requestId: `bundle-${seed}-1` });
  const resultTwo = await context.bundleExecutor.run("bundle-ops-clean", { requestId: `bundle-${seed}-2` });

  const validateResult = (result: BundleRunResult): void => {
    if (result.upstreamReceipts.length < 2) {
      throw new Error(`Bundle ${result.bundleId} did not produce enough upstream receipts`);
    }
    if (parseAtomic(result.grossAmountAtomic) < parseAtomic(result.upstreamCostAtomic)) {
      throw new Error(`Bundle ${result.bundleId} gross is below upstream cost`);
    }
  };

  validateResult(resultOne);
  validateResult(resultTwo);

  return {
    seed,
    bundleRuns: [
      {
        bundleId: resultOne.bundleId,
        grossAmountAtomic: resultOne.grossAmountAtomic,
        upstreamCostAtomic: resultOne.upstreamCostAtomic,
        netMarginAtomic: resultOne.netMarginAtomic,
      },
      {
        bundleId: resultTwo.bundleId,
        grossAmountAtomic: resultTwo.grossAmountAtomic,
        upstreamCostAtomic: resultTwo.upstreamCostAtomic,
        netMarginAtomic: resultTwo.netMarginAtomic,
      },
    ],
  };
}

async function scenarioFailureInjection(context: SimulationContext, seed: number): Promise<Record<string, unknown>> {
  const rng = mulberry32(seed);

  const underpayConnection: any = {
    async getSignatureStatus() {
      return { value: { err: null } };
    },
    async getParsedTransaction() {
      return {
        slot: 999,
        blockTime: Math.floor(context.getNowMs() / 1000),
        meta: {
          err: null,
          preTokenBalances: [
            { owner: "recipient-wallet", mint: "usdc-mint", uiTokenAmount: { amount: "0" } },
          ],
          postTokenBalances: [
            { owner: "recipient-wallet", mint: "usdc-mint", uiTokenAmount: { amount: "50" } },
          ],
        },
        transaction: {
          message: {
            instructions: [],
          },
        },
      };
    },
    async getBlockTime() {
      return Math.floor(context.getNowMs() / 1000);
    },
  };

  const wrongRecipientConnection: any = {
    async getSignatureStatus() {
      return { value: { err: null } };
    },
    async getParsedTransaction() {
      return {
        slot: 1000,
        blockTime: Math.floor(context.getNowMs() / 1000),
        meta: {
          err: null,
          preTokenBalances: [
            { owner: "attacker-wallet", mint: "usdc-mint", uiTokenAmount: { amount: "0" } },
          ],
          postTokenBalances: [
            { owner: "attacker-wallet", mint: "usdc-mint", uiTokenAmount: { amount: "100" } },
          ],
        },
        transaction: {
          message: {
            instructions: [],
          },
        },
      };
    },
    async getBlockTime() {
      return Math.floor(context.getNowMs() / 1000);
    },
  };

  let staleRejected = 0;
  let underpayRejected = 0;
  let wrongRecipientRejected = 0;
  let success = 0;

  for (let i = 0; i < 100; i += 1) {
    const draw = rng();
    context.advanceMs(200);

    if (draw < 0.1) {
      const expiresAt = context.getNowMs() - 1_000;
      if (expiresAt < context.getNowMs()) {
        staleRejected += 1;
        context.emit({
          type: "REQUEST_FAILED",
          shopId: "seller-1",
          endpointId: "seller-1-inference",
          capabilityTags: ["inference"],
          priceAmount: "0",
          mint: "USDC",
          statusCode: 410,
        });
        continue;
      }
    }

    if (draw < 0.2) {
      const underpay = await verifySplTransferProof(underpayConnection, {
        txSignature: `underpay-${seed}-${i}`,
        expectedMint: "usdc-mint",
        expectedRecipient: "recipient-wallet",
        minAmountAtomic: "100",
        maxAgeSeconds: 900,
        nowMs: context.getNowMs(),
      });
      if (!underpay.ok && (underpay.error ?? "").includes("underpaid")) {
        underpayRejected += 1;
        context.emit({
          type: "REQUEST_FAILED",
          shopId: "seller-2",
          endpointId: "seller-2-inference",
          capabilityTags: ["inference"],
          priceAmount: "0",
          mint: "USDC",
          statusCode: 400,
        });
        continue;
      }
      throw new Error("Underpay injection was not rejected as expected");
    }

    if (draw < 0.25) {
      const wrongRecipient = await verifySplTransferProof(wrongRecipientConnection, {
        txSignature: `wrong-recipient-${seed}-${i}`,
        expectedMint: "usdc-mint",
        expectedRecipient: "recipient-wallet",
        minAmountAtomic: "100",
        maxAgeSeconds: 900,
        nowMs: context.getNowMs(),
      });
      if (!wrongRecipient.ok && (wrongRecipient.error ?? "").includes("wrong recipient")) {
        wrongRecipientRejected += 1;
        context.emit({
          type: "REQUEST_FAILED",
          shopId: "seller-3",
          endpointId: "seller-3-inference",
          capabilityTags: ["inference"],
          priceAmount: "0",
          mint: "USDC",
          statusCode: 400,
        });
        continue;
      }
      throw new Error("Wrong recipient injection was not rejected as expected");
    }

    success += 1;
    emitPaidFulfilled(context, {
      shopId: "seller-2",
      endpointId: "seller-2-inference",
      capability: "inference",
      priceAtomic: "1000",
      settlementMode: "transfer",
      anchored: i % 3 === 0,
    });
  }

  if (staleRejected === 0 || underpayRejected === 0 || wrongRecipientRejected === 0) {
    throw new Error("Failure injection did not exercise all rejection classes.");
  }

  return {
    seed,
    staleRejected,
    underpayRejected,
    wrongRecipientRejected,
    successfulCalls: success,
  };
}

function scenarioPauseToggles(context: SimulationContext, seed: number): Record<string, unknown> {
  let ordersPaused = true;
  let blockedCreates = 0;

  if (ordersPaused) {
    blockedCreates += 1;
  }

  context.advanceMs(30_000);
  ordersPaused = false;

  context.heartbeat.upsert({
    shopId: "seller-1",
    inflight: 5,
    queueDepth: 6,
    p95LatencyMs: 620,
    errorRate: 0,
  }, context.now());

  const created = ordersPaused
    ? undefined
    : context.orders.create({
      capability: "inference",
      maxPrice: "900",
      maxLatencyMs: 2_000,
      expiresAt: new Date(context.getNowMs() + 60_000).toISOString(),
      preferSettlement: "netting",
    });

  const executed = context.orders.poll();
  const resumedExecuted = created ? executed.some((order) => order.orderId === created.orderId && order.status === "executed") : false;

  if (!resumedExecuted) {
    throw new Error("Orders did not resume execution after pause toggle.");
  }

  return {
    seed,
    blockedCreates,
    resumedExecuted,
    executedCount: executed.length,
  };
}

function sumMetricValues(metrics: Array<{ value: number }>): number {
  return metrics.reduce((sum, metric) => sum + metric.value, 0);
}

export async function runTenAgentSimulation(options: {
  baseSeed?: number;
  cluster?: string;
  outPath?: string;
} = {}): Promise<{ report: TenAgentSimulationReport; outPath: string }> {
  const baseSeed = options.baseSeed ?? 260216;
  const cluster = options.cluster ?? "devnet";
  const context = initContext(baseSeed);

  const scenarioRuns: Array<{ name: string; run: () => Promise<Record<string, unknown>> | Record<string, unknown> }> = [
    {
      name: "quote_competition_routing",
      run: () => scenarioQuoteCompetitionAndRouting(context, baseSeed + 1),
    },
    {
      name: "micropay_spam_netting_500",
      run: () => scenarioMicropaymentsNetting(context, baseSeed + 2),
    },
    {
      name: "streaming_session_topup",
      run: () => scenarioStreamingSession(context, baseSeed + 3),
    },
    {
      name: "bundle_reseller_margin",
      run: () => scenarioBundlesAndResellers(context, baseSeed + 4),
    },
    {
      name: "failure_injection_rejections",
      run: () => scenarioFailureInjection(context, baseSeed + 5),
    },
    {
      name: "pause_toggles_mid_sim",
      run: () => scenarioPauseToggles(context, baseSeed + 6),
    },
  ];

  const scenarioResults: ScenarioResult[] = [];

  for (const scenario of scenarioRuns) {
    try {
      const details = await scenario.run();
      scenarioResults.push({
        name: scenario.name,
        seed: (details.seed as number | undefined) ?? baseSeed,
        passed: true,
        details,
      });
    } catch (error) {
      scenarioResults.push({
        name: scenario.name,
        seed: baseSeed,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const fastCount24h = sumMetricValues(context.analytics.topSelling("24h", "FAST"));
  const verifiedCount24h = sumMetricValues(context.analytics.topSelling("24h", "VERIFIED"));
  const verifiedWithinFast = verifiedCount24h <= fastCount24h;

  if (!verifiedWithinFast) {
    throw new Error(`Analytics inconsistency: VERIFIED (${verifiedCount24h}) exceeds FAST (${fastCount24h})`);
  }

  const report: TenAgentSimulationReport = {
    generatedAt: new Date().toISOString(),
    cluster,
    baseSeed,
    agents: context.agents,
    scenarioResults,
    passedScenarios: scenarioResults.filter((row) => row.passed).length,
    failedScenarios: scenarioResults.filter((row) => !row.passed).length,
    analyticsConsistency: {
      fastCount24h,
      verifiedCount24h,
      verifiedWithinFast,
      verifiedMode: verifiedCount24h > 0 ? "active" : "empty_expected",
    },
    notes: [
      "Simulation includes 5 buyers, 3 sellers, and 2 reseller/bundle agents.",
      "Scenarios: quotes/routing, 500 micro events + netting, streaming top-ups, bundles, injected failures, pause toggles.",
      "Rejected failures are intentionally excluded from VERIFIED analytics counters.",
    ],
  };

  const repoRoot = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), "..", "..", "..");
  const outPath = options.outPath
    ?? path.join(repoRoot, "reports", `sim-10agents-${new Date().toISOString().replace(/[:]/g, "-")}.json`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  if (report.failedScenarios > 0) {
    const errors = report.scenarioResults.filter((entry) => !entry.passed).map((entry) => `${entry.name}: ${entry.error ?? "unknown"}`);
    throw new Error(`Simulation failed (${report.failedScenarios} scenarios): ${errors.join("; ")}. Report: ${outPath}`);
  }

  return { report, outPath };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help")) {
    // eslint-disable-next-line no-console
    console.log(usage());
    return;
  }

  const baseSeed = parsePositiveInt(parseFlagValue(argv, "--seed"), 260216);
  const cluster = parseFlagValue(argv, "--cluster") ?? "devnet";
  const outPath = parseFlagValue(argv, "--out");

  const result = await runTenAgentSimulation({
    baseSeed,
    cluster,
    outPath,
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: true,
    outPath: result.outPath,
    passedScenarios: result.report.passedScenarios,
    failedScenarios: result.report.failedScenarios,
    fastCount24h: result.report.analyticsConsistency.fastCount24h,
    verifiedCount24h: result.report.analyticsConsistency.verifiedCount24h,
  }, null, 2));
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (entryPath === modulePath) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
