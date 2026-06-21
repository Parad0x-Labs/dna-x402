#!/usr/bin/env node
/**
 * Anchor a real cross-layer accountability root on Solana MAINNET via the LIVE
 * `receipt_anchor` program (6HSRGivd…) — no new deploy, just a transaction.
 *
 * Builds a cross-layer DAG batch (a payment → a private x402 access bound to it),
 * commits its Merkle root to the on-chain bucket accumulator, then reads the bucket
 * back and verifies the accumulation. Deterministic values → reproducible root.
 *
 * Env: RPC (mainnet), KEY (payer keypair), DAG (path to receipt-dag src).
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const KEY = process.env.KEY ?? "/key.json";
const DAG = process.env.DAG ?? "/work/dag/src/index.ts";

const {
  buildDagReceipt, buildX402AccessReceipt, verifyDagChain, traceProvenance,
  buildDagMerkleRoot, anchorDagRoot, hashAction, RECEIPT_ANCHOR_PROGRAM_ID,
} = await import(DAG);
const { Connection, Keypair, PublicKey } = await import("@solana/web3.js");

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY, "utf8"))));
const conn = new Connection(RPC, "confirmed");
const before = await conn.getBalance(payer.publicKey);
console.log(`payer ${payer.publicKey.toBase58()}  mainnet bal ${before / 1e9} SOL`);
console.log(`anchor program ${RECEIPT_ANCHOR_PROGRAM_ID} (live mainnet)\n`);

// ── a real cross-layer batch: agent pays, then privately proves access bound to that payment ──
const AGENT = "web0:agent-commitment:demo";
const payment = buildDagReceipt({
  agentPubkey: AGENT, layer: "payment", sequenceNonce: 0, timestamp: 1_000,
  actionHash: hashAction({ layer: "payment", amount: "5000", asset: "USDC", note: "x402 settlement" }),
});
const access = buildX402AccessReceipt({
  agentPubkey: AGENT,
  scopeHash: hashAction({ resource: "x402://api.web0.null/inference" }),
  epoch: 7,
  nullifier: hashAction({ nullifier: "single-use-access-token" }),
  fundingReceiptId: payment.receiptId,
  sequenceNonce: 1, parentReceiptId: payment.receiptId, timestamp: 2_000,
});
const batch = [payment, access];

const vr = verifyDagChain(batch);
const prov = traceProvenance(access.receiptId, batch);
const root = buildDagMerkleRoot(batch).toString("hex");
console.log(`DAG valid: ${vr.valid}   access traces: ${[...prov.reachedLayers].join(" + ")}`);
console.log(`cross-layer accountability root: ${root}\n`);

// ── commit it on mainnet (default programId = the live 6HSRGivd). Fresh bucket for a clean verify. ──
const bucketId = BigInt(Date.now());
const ar = await anchorDagRoot(batch, conn, payer, { bucketId });

// ── verify the on-chain bucket accumulated it: root == SHA-256([0;32] || anchor), count == 1 ──
const acc = await conn.getAccountInfo(new PublicKey(ar.bucketPda), "confirmed");
const onRoot = Buffer.from(acc.data.slice(14, 46)).toString("hex");
const onCount = acc.data.readUInt32LE(10);
const expect = createHash("sha256").update(Buffer.concat([Buffer.alloc(32), Buffer.from(ar.anchor, "hex")])).digest("hex");
const verified = onRoot === expect && onCount === 1;
const after = await conn.getBalance(payer.publicKey);

console.log(`✅ ANCHORED ON MAINNET`);
console.log(`   tx        ${ar.signature}`);
console.log(`   bucket    ${ar.bucketPda}  (count=${onCount}, accumulated-root verified=${verified})`);
console.log(`   cost      ${((before - after) / 1e9).toFixed(6)} SOL  (remaining ${(after / 1e9).toFixed(6)})`);
console.log(`   solscan   https://solscan.io/tx/${ar.signature}`);
console.log(`   bucket    https://solscan.io/account/${ar.bucketPda}`);
process.exit(verified ? 0 : 1);
