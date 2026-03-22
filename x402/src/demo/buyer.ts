import {
  fetchWith402,
  InMemoryReceiptStore,
  InMemorySpendTracker,
} from "../sdk/index.js";
import type { AgentWallet, FetchWith402Result } from "../client.js";
import type { PaymentProof, QuoteResponse } from "../types.js";
import { DEMO_RESOURCES, demoProofValue, DemoMode } from "./shared.js";

export interface DemoBuyerRunOptions {
  baseUrl?: string;
  mode?: DemoMode;
  quiet?: boolean;
}

export interface DemoBuyerResult {
  mode: DemoMode;
  baseUrl: string;
  receiptCount: number;
  results: Array<{
    resource: string;
    status: number;
    receiptId?: string;
  }>;
}

function createDemoWallet(mode: DemoMode): AgentWallet {
  const makeProof = (quote: QuoteResponse): PaymentProof => {
    if (mode === "transfer") {
      return {
        settlement: "transfer",
        txSignature: demoProofValue("transfer", quote.quoteId),
        amountAtomic: quote.totalAtomic,
      };
    }
    if (mode === "stream") {
      return {
        settlement: "stream",
        streamId: demoProofValue("stream", quote.quoteId),
        amountAtomic: quote.totalAtomic,
      };
    }
    return {
      settlement: "netting",
      amountAtomic: quote.totalAtomic,
      note: "demo-netting",
    };
  };

  return {
    payTransfer: async (quote) => makeProof(quote),
    payStream: async (quote) => makeProof(quote),
    payNetted: async (quote) => makeProof(quote),
  };
}

async function callPaidApi(
  baseUrl: string,
  resource: string,
  mode: DemoMode,
  receipts: InMemoryReceiptStore,
  spendTracker: InMemorySpendTracker,
): Promise<FetchWith402Result> {
  return fetchWith402(`${baseUrl}${resource}`, {
    wallet: createDemoWallet(mode),
    maxSpendAtomic: "100000",
    maxSpendPerDayAtomic: "5000000",
    preferStream: mode === "stream",
    preferNetting: mode === "netting",
    receiptStore: receipts,
    spendTracker,
  });
}

export async function runDemoBuyer(options: DemoBuyerRunOptions = {}): Promise<DemoBuyerResult> {
  const mode = options.mode ?? "transfer";
  const baseUrl = options.baseUrl ?? "http://127.0.0.1:3000";
  const receipts = new InMemoryReceiptStore();
  const spendTracker = new InMemorySpendTracker();
  const results: DemoBuyerResult["results"] = [];

  if (!options.quiet) {
    console.log("DNA x402 demo buyer starting...");
    console.log(`Server: ${baseUrl}`);
    console.log(`Settlement mode: ${mode}`);
  }

  for (const resource of DEMO_RESOURCES) {
    const result = await callPaidApi(baseUrl, resource.path, mode, receipts, spendTracker);
    const receiptId = result.receipt?.payload.receiptId;
    results.push({
      resource: resource.path,
      status: result.response.status,
      receiptId,
    });
    if (!options.quiet) {
      console.log(`${resource.path} → ${result.response.status}${receiptId ? ` ${receiptId}` : ""}`);
    }
  }

  if (!options.quiet) {
    console.log(`Receipts collected: ${receipts.receipts.size} (payment + delivery receipts)`);
  }

  return {
    mode,
    baseUrl,
    receiptCount: receipts.receipts.size,
    results,
  };
}
