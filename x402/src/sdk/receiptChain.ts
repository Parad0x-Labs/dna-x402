/**
 * x402 Receipt Chains — multi-party agent payment graphs with cascade refunds.
 *
 * First x402 implementation of composable receipt chains.
 *
 * When agent A calls agent B, which subcontracts work to agent C:
 *   A → pays B  (quoteId: "q-b", parentReceiptId: null,  depth: 0)
 *   B → pays C  (quoteId: "q-c", parentReceiptId: "r-b", depth: 1)
 *   C → pays D  (quoteId: "q-d", parentReceiptId: "r-c", depth: 2)
 *
 * Each receipt in the chain references its parent. The full chain is
 * queryable at GET /receipt/:id/chain — root to leaf.
 *
 * Max chain depth: 4 (prevents loops and unbounded recursion).
 *
 * Usage (agent subcontracting):
 *   // Agent A's call to agent B:
 *   const resultB = await fetchWith402("https://agent-b.example/task", {
 *     wallet, maxSpendAtomic: "20000",
 *   });
 *   const parentReceiptId = resultB.receipt?.payload.receiptId;
 *
 *   // Agent B subcontracts to agent C, linking back to A's receipt:
 *   const resultC = await fetchWithChain("https://agent-c.example/subtask", {
 *     wallet, maxSpendAtomic: "8000",
 *     chain: { parentReceiptId },
 *   });
 */

export const CHAIN_PARENT_HEADER = "x-dnp-parent-receipt";
export const CHAIN_DEPTH_HEADER = "x-dnp-chain-depth";
export const MAX_CHAIN_DEPTH = 4;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ChainLink {
  receiptId: string;
  parentReceiptId: string | null;
  depth: number;
  amountAtomic: string;
  resource: string;
  createdAt: string;
}

export interface ChainResponse {
  root: ChainLink;
  chain: ChainLink[];
  totalDepth: number;
  totalAmountAtomic: string;
}

export interface FetchWithChainOptions {
  chain: {
    /** Receipt ID of the parent payment in the chain. */
    parentReceiptId: string;
    /** Current depth (default: 1, auto-incremented from parent). */
    depth?: number;
  };
  [key: string]: unknown;
}

// ── Client helpers ────────────────────────────────────────────────────────────

/**
 * Make an x402 payment that is linked to a parent receipt.
 *
 * Adds x-dnp-parent-receipt and x-dnp-chain-depth headers so the server
 * can build the receipt chain.  Throws if depth would exceed MAX_CHAIN_DEPTH.
 */
export async function fetchWithChain(
  url: string,
  options: FetchWithChainOptions,
): Promise<unknown> {
  const { chain, ...baseOptions } = options;
  const depth = chain.depth ?? 1;

  if (depth > MAX_CHAIN_DEPTH) {
    throw new Error(
      `fetchWithChain: chain depth ${depth} exceeds maximum ${MAX_CHAIN_DEPTH}`,
    );
  }

  const existingHeaders = (baseOptions as { headers?: HeadersInit }).headers;
  const headers = new Headers(existingHeaders);
  headers.set(CHAIN_PARENT_HEADER, chain.parentReceiptId);
  headers.set(CHAIN_DEPTH_HEADER, String(depth));

  const { fetchWith402 } = await import("../client.js");
  return fetchWith402(url, {
    ...(baseOptions as Parameters<typeof fetchWith402>[1]),
    headers,
  });
}

/**
 * Retrieve the full receipt chain for a given receipt ID.
 * Returns root-to-leaf ordered array of ChainLink records.
 */
export async function getReceiptChain(
  baseUrl: string,
  receiptId: string,
): Promise<ChainResponse> {
  const url = new URL(baseUrl);
  url.pathname = `/receipt/${receiptId}/chain`;
  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`getReceiptChain: HTTP ${res.status}`);
  }
  return res.json() as Promise<ChainResponse>;
}

// ── Header parsing ────────────────────────────────────────────────────────────

/** Parse x-dnp-chain-depth header — returns 0 for absent/invalid. */
export function parseChainDepth(raw: string | undefined): number {
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  if (!isFinite(n) || n < 0) return 0;
  return Math.min(n, MAX_CHAIN_DEPTH + 1); // clamp, server enforces
}
