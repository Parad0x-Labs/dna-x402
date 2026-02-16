import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { NettingLedger } from "../src/nettingLedger.js";
import { ReceiptSigner, verifySignedReceipt } from "../src/receipts.js";
import { createSignedManifest } from "../src/market/manifest.js";
import { BundleExecutor } from "../src/market/bundleExecutor.js";
import { BundleRegistry, createSignedBundleManifest } from "../src/market/bundles.js";
import { HeartbeatIndex } from "../src/market/heartbeat.js";
import { MarketOrders } from "../src/market/orders.js";
import { QuoteBook } from "../src/market/quotes.js";
import { MarketRegistry } from "../src/market/registry.js";
import { ShopManifest } from "../src/market/types.js";

type ScenarioName =
  | "quote_competition_under_saturation"
  | "limit_orders_wait_until_cheap"
  | "bundle_execution_path"
  | "netting_settlement_path"
  | "receipt_chain_verification";

interface ScenarioResult {
  scenario: ScenarioName;
  seed: number;
  details: Record<string, unknown>;
}

interface SimulationFailure {
  index: number;
  scenario: ScenarioName;
  seed: number;
  error: string;
}

interface ScenarioStats {
  runs: number;
  passes: number;
  failures: number;
}

interface SimulationReport {
  generatedAt: string;
  runsRequested: number;
  runsExecuted: number;
  baseSeed: number;
  passCount: number;
  failCount: number;
  failureRate: number;
  scenarioStats: Record<ScenarioName, ScenarioStats>;
  failures: SimulationFailure[];
  notes: string[];
}

function usage(): string {
  return [
    "Usage: npm run sim:1005 -- [options]",
    "",
    "Options:",
    "  --runs <n>         Number of simulations (default: 1005)",
    "  --seed <n>         Base deterministic seed (default: 424242)",
    "  --only-index <n>   Replay a single index",
    "  --out <path>       Output JSON path (default: ../reports/sim-1005-<timestamp>.json)",
    "  --fail-fast        Stop on first failure",
    "  --help             Show this help",
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
  const secret = new Uint8Array(64);
  for (let i = 0; i < 32; i += 1) {
    secret[i] = randomInt(rng, 0, 255);
  }
  const kp = nacl.sign.keyPair.fromSeed(secret.slice(0, 32));
  return {
    ownerPubkey: bs58.encode(kp.publicKey),
    ownerSecret: bs58.encode(kp.secretKey),
  };
}

function registerShop(registry: MarketRegistry, params: {
  seed: number;
  shopId: string;
  capability: string;
  priceAtomic: string;
  latencyMs: number;
  pricingModel?: ShopManifest["endpoints"][number]["pricingModel"];
}): void {
  const signer = deterministicSigner(params.seed);
  const manifest: ShopManifest = {
    manifestVersion: "market-v1",
    shopId: params.shopId,
    name: `${params.shopId} shop`,
    ownerPubkey: signer.ownerPubkey,
    endpoints: [
      {
        endpointId: `${params.shopId}-endpoint`,
        method: "POST",
        path: "/resource",
        capabilityTags: [params.capability],
        description: `${params.capability} endpoint`,
        pricingModel: params.pricingModel ?? { kind: "flat", amountAtomic: params.priceAtomic },
        settlementModes: ["transfer", "stream", "netting"],
        sla: {
          maxLatencyMs: params.latencyMs,
          availabilityTarget: 0.995,
        },
      },
    ],
  };
  const signed = createSignedManifest(manifest, signer.ownerSecret);
  registry.register(signed);
}

function scenarioQuoteCompetition(seed: number): ScenarioResult {
  const rng = mulberry32(seed);
  const registry = new MarketRegistry();
  const heartbeat = new HeartbeatIndex();
  const signer = ReceiptSigner.generate();

  registerShop(registry, {
    seed: seed + 11,
    shopId: "shop-cheap",
    capability: "inference",
    priceAtomic: "700",
    latencyMs: 900,
    pricingModel: {
      kind: "surge",
      baseAmountAtomic: "700",
      minMultiplier: 0.8,
      maxMultiplier: 3.0,
    },
  });
  registerShop(registry, {
    seed: seed + 12,
    shopId: "shop-mid",
    capability: "inference",
    priceAtomic: "1000",
    latencyMs: 650,
  });
  registerShop(registry, {
    seed: seed + 13,
    shopId: "shop-premium",
    capability: "inference",
    priceAtomic: "1400",
    latencyMs: 500,
  });

  heartbeat.upsert({
    shopId: "shop-cheap",
    inflight: randomInt(rng, 60, 95),
    queueDepth: randomInt(rng, 120, 220),
    p95LatencyMs: randomInt(rng, 2200, 3800),
    errorRate: 0.03,
  }, new Date());

  heartbeat.upsert({
    shopId: "shop-mid",
    inflight: randomInt(rng, 15, 30),
    queueDepth: randomInt(rng, 10, 35),
    p95LatencyMs: randomInt(rng, 700, 1100),
    errorRate: 0.01,
  }, new Date());

  heartbeat.upsert({
    shopId: "shop-premium",
    inflight: randomInt(rng, 5, 20),
    queueDepth: randomInt(rng, 5, 20),
    p95LatencyMs: randomInt(rng, 450, 700),
    errorRate: 0.005,
  }, new Date());

  const quoteBook = new QuoteBook(registry, heartbeat, signer, (shopId) => {
    if (shopId === "shop-premium") {
      return 0.96;
    }
    if (shopId === "shop-mid") {
      return 0.9;
    }
    return 0.82;
  });

  const quotes = quoteBook.list({
    capability: "inference",
    maxPriceAtomic: "100000",
    limit: 3,
  });

  if (quotes.length < 2) {
    throw new Error("Quote competition scenario returned fewer than 2 quotes");
  }

  const cheapQuote = quotes.find((quote) => quote.shopId === "shop-cheap");
  const midQuote = quotes.find((quote) => quote.shopId === "shop-mid");
  if (!cheapQuote || !midQuote) {
    throw new Error("Expected shops were not quoted");
  }

  if (BigInt(cheapQuote.price) <= BigInt(midQuote.price) / 2n) {
    throw new Error("Surge pricing under load did not apply to saturated shop");
  }

  return {
    scenario: "quote_competition_under_saturation",
    seed,
    details: {
      quotesReturned: quotes.length,
      topShop: quotes[0].shopId,
      cheapPriceAtomic: cheapQuote.price,
      midPriceAtomic: midQuote.price,
    },
  };
}

function scenarioLimitOrders(seed: number): ScenarioResult {
  let currentMs = Date.parse("2026-02-16T00:00:00.000Z");
  const now = () => new Date(currentMs);
  const registry = new MarketRegistry();
  const heartbeat = new HeartbeatIndex();
  const signer = ReceiptSigner.generate();

  registerShop(registry, {
    seed: seed + 21,
    shopId: "shop-order",
    capability: "pdf_summarize",
    priceAtomic: "1000",
    latencyMs: 1200,
    pricingModel: {
      kind: "surge",
      baseAmountAtomic: "1000",
      minMultiplier: 0.8,
      maxMultiplier: 2.8,
    },
  });

  const quoteBook = new QuoteBook(registry, heartbeat, signer, () => 0.9);
  const orders = new MarketOrders(quoteBook, now);

  heartbeat.upsert({
    shopId: "shop-order",
    inflight: 90,
    queueDepth: 200,
    p95LatencyMs: 3200,
    errorRate: 0.04,
  }, now());

  const order = orders.create({
    capability: "pdf_summarize",
    maxPrice: "1200",
    maxLatencyMs: 2500,
    expiresAt: new Date(currentMs + 60_000).toISOString(),
    preferSettlement: "transfer",
  });

  const firstPoll = orders.poll();
  if (firstPoll.length !== 0) {
    throw new Error("Order executed too early while price was above maxPrice");
  }

  currentMs += 15_000;
  heartbeat.upsert({
    shopId: "shop-order",
    inflight: 8,
    queueDepth: 12,
    p95LatencyMs: 700,
    errorRate: 0,
  }, now());

  const secondPoll = orders.poll();
  if (secondPoll.length !== 1 || secondPoll[0].orderId !== order.orderId) {
    throw new Error("Order did not execute when load dropped");
  }

  return {
    scenario: "limit_orders_wait_until_cheap",
    seed,
    details: {
      orderId: order.orderId,
      chosenShop: secondPoll[0].chosenQuote?.shopId,
      chosenPriceAtomic: secondPoll[0].chosenQuote?.price,
    },
  };
}

async function scenarioBundleExecution(seed: number): Promise<ScenarioResult> {
  const registry = new MarketRegistry();
  const heartbeat = new HeartbeatIndex();
  const quoteSigner = ReceiptSigner.generate();

  registerShop(registry, {
    seed: seed + 31,
    shopId: "shop-fetch",
    capability: "pdf_fetch_extract",
    priceAtomic: "500",
    latencyMs: 1200,
  });
  registerShop(registry, {
    seed: seed + 32,
    shopId: "shop-summarize",
    capability: "summarize_with_quotes",
    priceAtomic: "700",
    latencyMs: 900,
  });

  const quoteBook = new QuoteBook(registry, heartbeat, quoteSigner, () => 0.92);
  const bundles = new BundleRegistry();
  const owner = deterministicSigner(seed + 33);

  bundles.register(createSignedBundleManifest({
    bundleId: "bundle-research",
    ownerPubkey: owner.ownerPubkey,
    name: "Deep Research Bundle",
    steps: [
      { capability: "pdf_fetch_extract" },
      { capability: "summarize_with_quotes" },
    ],
    bundlePriceModel: {
      kind: "flat",
      amountAtomic: "1600",
    },
    marginPolicy: {
      kind: "percent",
      value: 10,
    },
  }, owner.ownerSecret));

  const executor = new BundleExecutor(bundles, quoteBook);
  const result = await executor.run("bundle-research", { requestId: `seed-${seed}` });

  if (result.upstreamReceipts.length !== 2) {
    throw new Error("Bundle execution did not produce two upstream receipts");
  }
  if (BigInt(result.grossAmountAtomic) < BigInt(result.upstreamCostAtomic)) {
    throw new Error("Bundle gross amount is lower than upstream cost");
  }

  return {
    scenario: "bundle_execution_path",
    seed,
    details: {
      bundleId: result.bundleId,
      executionId: result.executionId,
      grossAmountAtomic: result.grossAmountAtomic,
      upstreamCostAtomic: result.upstreamCostAtomic,
      netMarginAtomic: result.netMarginAtomic,
    },
  };
}

function scenarioNetting(seed: number): ScenarioResult {
  const ledger = new NettingLedger({
    settleThresholdAtomic: 1_000n,
    settleIntervalMs: 5_000,
  });

  const createdAtMs = Date.parse("2026-02-16T00:00:00.000Z") + seed;
  for (let i = 0; i < 100; i += 1) {
    ledger.add({
      payerCommitment32B: "aa".repeat(32),
      providerId: "provider-a",
      amountAtomic: "1",
      quoteId: `q-${seed}-${i}`,
      commitId: `c-${seed}-${i}`,
      createdAtMs: createdAtMs + i * 10,
    });
  }

  const batches = ledger.flushReady(createdAtMs + 6_000);
  if (batches.length !== 1) {
    throw new Error(`Expected 1 netting batch, got ${batches.length}`);
  }
  if (batches[0].settleAmountAtomic !== "100") {
    throw new Error(`Unexpected net settle amount: ${batches[0].settleAmountAtomic}`);
  }

  return {
    scenario: "netting_settlement_path",
    seed,
    details: {
      batchCount: batches.length,
      settleAmountAtomic: batches[0].settleAmountAtomic,
      chargesAggregated: batches[0].quoteIds.length,
    },
  };
}

function scenarioReceiptChain(seed: number): ScenarioResult {
  const signer = ReceiptSigner.generate();
  const receipts = [];

  for (let i = 0; i < 12; i += 1) {
    const receipt = signer.sign({
      receiptId: `receipt-${seed}-${i}`,
      quoteId: `quote-${i}`,
      commitId: `commit-${i}`,
      resource: "/resource",
      payerCommitment32B: `${(seed % 256).toString(16).padStart(2, "0")}`.repeat(32),
      recipient: "recipient-test",
      mint: "USDC",
      amountAtomic: "1000",
      feeAtomic: "10",
      totalAtomic: "1010",
      settlement: "transfer",
      settledOnchain: true,
      txSignature: `tx-${seed}-${i}`,
      createdAt: new Date(Date.parse("2026-02-16T00:00:00.000Z") + i * 1000).toISOString(),
    });
    receipts.push(receipt);
  }

  for (let i = 0; i < receipts.length; i += 1) {
    if (!verifySignedReceipt(receipts[i])) {
      throw new Error(`Receipt signature check failed at index ${i}`);
    }
    if (i > 0 && receipts[i].prevHash !== receipts[i - 1].receiptHash) {
      throw new Error(`Receipt chain continuity failed at index ${i}`);
    }
  }

  return {
    scenario: "receipt_chain_verification",
    seed,
    details: {
      receipts: receipts.length,
      finalHash: receipts[receipts.length - 1].receiptHash,
    },
  };
}

const SCENARIO_ORDER: ScenarioName[] = [
  "quote_competition_under_saturation",
  "limit_orders_wait_until_cheap",
  "bundle_execution_path",
  "netting_settlement_path",
  "receipt_chain_verification",
];

async function runScenario(name: ScenarioName, seed: number): Promise<ScenarioResult> {
  switch (name) {
    case "quote_competition_under_saturation":
      return scenarioQuoteCompetition(seed);
    case "limit_orders_wait_until_cheap":
      return scenarioLimitOrders(seed);
    case "bundle_execution_path":
      return scenarioBundleExecution(seed);
    case "netting_settlement_path":
      return scenarioNetting(seed);
    case "receipt_chain_verification":
      return scenarioReceiptChain(seed);
    default:
      throw new Error(`Unhandled scenario: ${name}`);
  }
}

function emptyStats(): Record<ScenarioName, ScenarioStats> {
  return {
    quote_competition_under_saturation: { runs: 0, passes: 0, failures: 0 },
    limit_orders_wait_until_cheap: { runs: 0, passes: 0, failures: 0 },
    bundle_execution_path: { runs: 0, passes: 0, failures: 0 },
    netting_settlement_path: { runs: 0, passes: 0, failures: 0 },
    receipt_chain_verification: { runs: 0, passes: 0, failures: 0 },
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, "--help")) {
    // eslint-disable-next-line no-console
    console.log(usage());
    return;
  }

  const runs = parsePositiveInt(parseFlagValue(argv, "--runs"), 1005);
  const baseSeed = parsePositiveInt(parseFlagValue(argv, "--seed"), 424242);
  const onlyIndexRaw = parseFlagValue(argv, "--only-index");
  const onlyIndex = onlyIndexRaw !== undefined ? Number.parseInt(onlyIndexRaw, 10) : undefined;
  const failFast = hasFlag(argv, "--fail-fast");

  const repoRoot = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), "..", "..");
  const outPath = parseFlagValue(argv, "--out")
    ?? path.join(repoRoot, "reports", `sim-1005-${new Date().toISOString().replace(/[:]/g, "-")}.json`);

  const failures: SimulationFailure[] = [];
  const stats = emptyStats();
  let passCount = 0;
  let runsExecuted = 0;

  for (let index = 0; index < runs; index += 1) {
    if (onlyIndex !== undefined && index !== onlyIndex) {
      continue;
    }

    const scenario = SCENARIO_ORDER[index % SCENARIO_ORDER.length];
    const seed = baseSeed + index;
    stats[scenario].runs += 1;
    runsExecuted += 1;

    try {
      await runScenario(scenario, seed);
      passCount += 1;
      stats[scenario].passes += 1;
    } catch (error) {
      const failure: SimulationFailure = {
        index,
        scenario,
        seed,
        error: error instanceof Error ? error.message : String(error),
      };
      failures.push(failure);
      stats[scenario].failures += 1;
      if (failFast) {
        break;
      }
    }
  }

  const failCount = failures.length;
  const report: SimulationReport = {
    generatedAt: new Date().toISOString(),
    runsRequested: runs,
    runsExecuted,
    baseSeed,
    passCount,
    failCount,
    failureRate: runsExecuted > 0 ? Number((failCount / runsExecuted).toFixed(6)) : 0,
    scenarioStats: stats,
    failures,
    notes: [
      "Deterministic simulation pack for audit gate before devnet deploy.",
      "Replay a failure with: npm run sim:1005 -- --seed <baseSeed> --only-index <index>.",
      "Scenarios covered: quote competition, limit orders, bundles, netting, receipt-chain verification.",
    ],
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ok: failCount === 0,
    outPath,
    runsRequested: report.runsRequested,
    runsExecuted: report.runsExecuted,
    passCount: report.passCount,
    failCount: report.failCount,
    failureRate: report.failureRate,
  }, null, 2));

  if (failCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});

