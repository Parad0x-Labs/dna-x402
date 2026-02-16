import crypto from "node:crypto";
import { parseAtomic } from "../feePolicy.js";
import { BundleRegistry } from "./bundles.js";
import { QuoteBook } from "./quotes.js";
import { BundleRunResult, MarketEvent } from "./types.js";

export interface BundleStepExecutionContext {
  bundleId: string;
  stepIndex: number;
  capability: string;
  quote?: {
    quoteId: string;
    shopId: string;
    endpointId: string;
    path: string;
    price: string;
  };
  input?: unknown;
}

export interface BundleStepExecutionResult {
  output: unknown;
  receiptId?: string;
}

export interface BundleExecutorOptions {
  now?: () => Date;
  executeStep?: (context: BundleStepExecutionContext) => Promise<BundleStepExecutionResult>;
  recordEvent?: (event: Omit<MarketEvent, "ts">) => void;
}

function hashHex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function nextChainHash(prevHash: string, payload: unknown): string {
  return hashHex(JSON.stringify({ prevHash, payload }));
}

export class BundleExecutor {
  private readonly now: () => Date;
  private readonly executeStep: (context: BundleStepExecutionContext) => Promise<BundleStepExecutionResult>;
  private readonly recordEvent?: (event: Omit<MarketEvent, "ts">) => void;
  private readonly lastBundleHash = new Map<string, string>();

  constructor(
    private readonly bundles: BundleRegistry,
    private readonly quoteBook: QuoteBook,
    options: BundleExecutorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.executeStep = options.executeStep ?? (async (context) => ({
      output: {
        ok: true,
        message: `executed ${context.capability}`,
      },
      receiptId: crypto.randomUUID(),
    }));
    this.recordEvent = options.recordEvent;
  }

  async run(bundleId: string, input?: unknown): Promise<BundleRunResult> {
    const bundle = this.bundles.get(bundleId);
    if (!bundle) {
      throw new Error(`bundle not found: ${bundleId}`);
    }

    const upstreamReceipts: BundleRunResult["upstreamReceipts"] = [];
    const stepOutputs: unknown[] = [];
    let upstreamCost = 0n;

    for (let stepIndex = 0; stepIndex < bundle.steps.length; stepIndex += 1) {
      const step = bundle.steps[stepIndex];
      const quote = this.quoteBook.list({
        capability: step.capability,
        maxPriceAtomic: step.constraints?.maxPriceAtomic,
        maxLatencyMs: step.constraints?.maxLatencyMs,
        limit: 1,
      })[0];

      const execution = await this.executeStep({
        bundleId,
        stepIndex,
        capability: step.capability,
        quote: quote ? {
          quoteId: quote.quoteId,
          shopId: quote.shopId,
          endpointId: quote.endpointId,
          path: quote.path,
          price: quote.price,
        } : undefined,
        input,
      });

      const amountAtomic = quote?.price;
      if (amountAtomic) {
        upstreamCost += parseAtomic(amountAtomic);
      }

      upstreamReceipts.push({
        stepIndex,
        quoteId: quote?.quoteId,
        shopId: quote?.shopId,
        endpointId: quote?.endpointId,
        receiptId: execution.receiptId ?? crypto.randomUUID(),
        amountAtomic,
      });
      stepOutputs.push(execution.output);

      this.recordEvent?.({
        type: "BUNDLE_STEP_EXECUTED",
        shopId: quote?.shopId ?? "bundle-orchestrator",
        endpointId: quote?.endpointId ?? step.capability,
        ownerPubkey: bundle.ownerPubkey,
        bundleId,
        capabilityTags: [step.capability],
        priceAmount: amountAtomic ?? "0",
        mint: "USDC",
        statusCode: 200,
        receiptId: execution.receiptId,
        verificationTier: "FAST",
      });
    }

    const configuredGross = bundle.bundlePriceModel.kind === "flat"
      ? parseAtomic(bundle.bundlePriceModel.amountAtomic)
      : parseAtomic(bundle.bundlePriceModel.amountPerRunAtomic);
    const gross = configuredGross > upstreamCost ? configuredGross : upstreamCost;
    const margin = gross - upstreamCost;

    const executionId = crypto.randomUUID();
    const payload = {
      executionId,
      bundleId,
      ts: this.now().toISOString(),
      upstreamReceipts,
      grossAmountAtomic: gross.toString(10),
      upstreamCostAtomic: upstreamCost.toString(10),
      netMarginAtomic: margin.toString(10),
    };

    const previousHash = this.lastBundleHash.get(bundleId) ?? "0".repeat(64);
    const receiptHash = nextChainHash(previousHash, payload);
    this.lastBundleHash.set(bundleId, receiptHash);

    this.recordEvent?.({
      type: "BUNDLE_RUN",
      shopId: "bundle-orchestrator",
      endpointId: bundleId,
      ownerPubkey: bundle.ownerPubkey,
      bundleId,
      capabilityTags: bundle.steps.map((step) => step.capability),
      priceAmount: gross.toString(10),
      upstreamCostAmount: upstreamCost.toString(10),
      netRevenueAmount: margin.toString(10),
      mint: "USDC",
      statusCode: 200,
      receiptId: executionId,
      anchor32: receiptHash.slice(0, 64),
      verificationTier: "FAST",
      receiptValid: true,
    });

    return {
      bundleId,
      executionId,
      output: {
        steps: stepOutputs,
      },
      bundleReceiptId: executionId,
      upstreamReceipts,
      grossAmountAtomic: gross.toString(10),
      upstreamCostAtomic: upstreamCost.toString(10),
      netMarginAtomic: margin.toString(10),
    };
  }
}
