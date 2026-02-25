/**
 * DNA x402 — Buyer Agent Example
 *
 * An AI agent that pays for API calls using DNA's netting mode.
 * Netting = off-chain batched micropayments. No per-call Solana tx fee.
 *
 * Run:
 *   npx tsx examples/buyer-agent.ts
 */
import {
  fetchWith402,
  InMemoryReceiptStore,
  InMemorySpendTracker,
} from "../src/sdk/index.js";
import type { AgentWallet, FetchWith402Result } from "../src/client.js";

const DNA_SERVER = process.env.DNA_SERVER ?? "http://localhost:8080";

const nettingWallet: AgentWallet = {
  payTransfer: async (quote) => ({
    settlement: "netting",
    amountAtomic: quote.totalAtomic,
    note: "buyer-agent-example",
  }),
  payNetted: async (quote) => ({
    settlement: "netting",
    amountAtomic: quote.totalAtomic,
    note: "buyer-agent-example",
  }),
};

const receipts = new InMemoryReceiptStore();
const spendTracker = new InMemorySpendTracker();

async function callPaidApi(resource: string): Promise<FetchWith402Result> {
  return fetchWith402(`${DNA_SERVER}${resource}`, {
    wallet: nettingWallet,
    maxSpendAtomic: "100000",         // $0.10 max per call
    maxSpendPerDayAtomic: "5000000",  // $5.00 daily budget
    receiptStore: receipts,
    spendTracker,
  });
}

async function main() {
  console.log("DNA Buyer Agent starting...");
  console.log("Server:", DNA_SERVER);

  const resources = ["/resource", "/inference", "/stream-access"];

  for (const r of resources) {
    try {
      const result = await callPaidApi(r);
      console.log(`${r} → ${result.response.status}`, result.receipt?.payload.receiptId ?? "");
    } catch (e) {
      console.error(`${r} failed:`, (e as Error).message);
    }
  }

  console.log("\nReceipts collected:", receipts.receipts.size);
  console.log("Done.");
}

main().catch(console.error);
