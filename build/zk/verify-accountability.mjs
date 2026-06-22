#!/usr/bin/env node
/**
 * Proof-of-accountability verifier (read-only) — anyone can run this.
 * Reconstructs the exact cross-layer batch (payment -> private x402 access) that was
 * anchored on Solana MAINNET, then verifies via the receipt-dag library that:
 *   (1) the DAG chain is valid (anti-equivocation + parent linkage),
 *   (2) its Merkle root matches, and
 *   (3) that root is the one anchored in the live receipt_anchor bucket.
 * No keys, no writes — pure read against the live program. Trust nobody, verify the root.
 *
 * Env: RPC (mainnet), DAG (receipt-dag src), BUCKET (the anchored bucket PDA).
 */
const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const DAG = process.env.DAG ?? "/work/dag/src/index.ts";
const BUCKET = process.env.BUCKET ?? "Ejr4XWczALR1GQ4T9ksaw9wfW3npZ5s7rYf7Dw6npXrc";

const { buildDagReceipt, buildX402AccessReceipt, buildDagMerkleRoot, verifyAccountability, traceProvenance, hashAction } =
  await import(DAG);
const { Connection } = await import("@solana/web3.js");
const conn = new Connection(RPC, "confirmed");

// Reconstruct the exact deterministic batch that was anchored (must match mainnet-anchor.mjs).
const AGENT = "web0:agent-commitment:demo";
const payment = buildDagReceipt({
  agentPubkey: AGENT, layer: "payment", sequenceNonce: 0, timestamp: 1000,
  actionHash: hashAction({ layer: "payment", amount: "5000", asset: "USDC", note: "x402 settlement" }),
});
const access = buildX402AccessReceipt({
  agentPubkey: AGENT, scopeHash: hashAction({ resource: "x402://api.web0.null/inference" }),
  epoch: 7, nullifier: hashAction({ nullifier: "single-use-access-token" }),
  fundingReceiptId: payment.receiptId, sequenceNonce: 1, parentReceiptId: payment.receiptId, timestamp: 2000,
});
const batch = [payment, access];

const root = buildDagMerkleRoot(batch).toString("hex");
const prov = traceProvenance(access.receiptId, batch);
console.log(`rebuilt cross-layer root: ${root}`);
console.log(`access provenance traces: ${[...prov.reachedLayers].join(" + ")}`);

const verdict = await verifyAccountability(batch, conn, { bucketPda: BUCKET });
console.log(JSON.stringify(verdict, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.log(
  verdict.accountable
    ? "\n✅ ACCOUNTABLE — chain valid + Merkle root anchored on Solana MAINNET, verified read-only against the live receipt_anchor bucket. No trust in web0 required."
    : "\n❌ NOT verified — see verdict above."
);
process.exit(verdict.accountable ? 0 : 1);
