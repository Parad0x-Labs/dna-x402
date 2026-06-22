#!/usr/bin/env node
/**
 * Proof-of-Agency — a portable, paste-to-verify "proof pack" for an AI agent's action.
 *
 * Encodes a cross-layer receipt batch (payment -> private x402 access) into a compact
 * base64url string (deflate). ANYONE can decode it and verify, read-only and keyless, that
 * the action was payment-backed, non-equivocating, and anchored on Solana MAINNET — with zero
 * trust in web0. Two fixtures prove the claim AND its failure mode:
 *   - the REAL pack (the batch actually anchored)        -> must verify GREEN (accountable)
 *   - a forged-but-internally-valid pack (different root) -> must go RED (not the anchored root)
 *
 * Local proof/kill. No on-chain writes — a single read of the live bucket.
 * Env: RPC (mainnet), DAG (receipt-dag src), BUCKET (the anchored bucket PDA).
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

const RPC = process.env.RPC ?? "https://api.mainnet-beta.solana.com";
const DAG = process.env.DAG ?? "/work/dag/src/index.ts";
const BUCKET = process.env.BUCKET ?? "Ejr4XWczALR1GQ4T9ksaw9wfW3npZ5s7rYf7Dw6npXrc";

const { buildDagReceipt, buildX402AccessReceipt, verifyAccountability, traceProvenance, hashAction } =
  await import(DAG);
const { Connection } = await import("@solana/web3.js");
const conn = new Connection(RPC, "confirmed");

const b64url = {
  enc: (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
};
// pack = base64url(deflate(JSON{ v, bucketPda, batch })) — a shareable proof string / QR payload
const pack = (batch, bucketPda) => b64url.enc(deflateRawSync(Buffer.from(JSON.stringify({ v: 1, bucketPda, batch }))));
const unpack = (s) => JSON.parse(inflateRawSync(b64url.dec(s)).toString());

// The exact deterministic batch anchored on mainnet (must match mainnet-anchor.mjs / verify-accountability.mjs).
const AGENT = "web0:agent-commitment:demo";
const realPayment = buildDagReceipt({
  agentPubkey: AGENT, layer: "payment", sequenceNonce: 0, timestamp: 1000,
  actionHash: hashAction({ layer: "payment", amount: "5000", asset: "USDC", note: "x402 settlement" }),
});
const realAccess = buildX402AccessReceipt({
  agentPubkey: AGENT, scopeHash: hashAction({ resource: "x402://api.web0.null/inference" }),
  epoch: 7, nullifier: hashAction({ nullifier: "single-use-access-token" }),
  fundingReceiptId: realPayment.receiptId, sequenceNonce: 1, parentReceiptId: realPayment.receiptId, timestamp: 2000,
});
const realBatch = [realPayment, realAccess];

// A forged batch: internally consistent (chain valid) but a DIFFERENT amount -> different root.
const fakePayment = buildDagReceipt({
  agentPubkey: AGENT, layer: "payment", sequenceNonce: 0, timestamp: 1000,
  actionHash: hashAction({ layer: "payment", amount: "9999999", asset: "USDC", note: "forged" }),
});
const fakeAccess = buildX402AccessReceipt({
  agentPubkey: AGENT, scopeHash: hashAction({ resource: "x402://api.web0.null/inference" }),
  epoch: 7, nullifier: hashAction({ nullifier: "single-use-access-token" }),
  fundingReceiptId: fakePayment.receiptId, sequenceNonce: 1, parentReceiptId: fakePayment.receiptId, timestamp: 2000,
});
const fakeBatch = [fakePayment, fakeAccess];

async function verifyPack(label, packStr) {
  const { batch, bucketPda } = unpack(packStr);                 // decode (anyone can do this)
  const v = await verifyAccountability(batch, conn, { bucketPda }); // read-only mainnet check
  const prov = traceProvenance(batch[batch.length - 1].receiptId, batch);
  return { label, len: packStr.length, accountable: v.accountable, chainValid: v.chainValid,
    rootAnchored: v.rootAnchored, traces: [...(prov.reachedLayers || [])].join("+"),
    root: (v.merkleRoot || "").slice(0, 16) };
}

const realPack = pack(realBatch, BUCKET);
const fakePack = pack(fakeBatch, BUCKET);
console.log(`real proof pack  (${realPack.length} chars): ${realPack.slice(0, 56)}…`);
console.log(`forged proof pack(${fakePack.length} chars): ${fakePack.slice(0, 56)}…\n`);

const real = await verifyPack("REAL  ", realPack);
const fake = await verifyPack("FORGED", fakePack);
for (const r of [real, fake]) console.log(JSON.stringify(r));

const pass =
  real.accountable === true && real.rootAnchored === true && real.traces.includes("payment") &&
  fake.accountable === false && fake.rootAnchored === false &&
  unpack(realPack).batch.length === realBatch.length;

console.log(`\nRESULT: ${pass
  ? "PASS — the real proof pack verifies GREEN against the live mainnet anchor; a forged-but-valid pack goes RED (its root was never anchored). Paste-to-verify works, keyless, no trust in web0."
  : "FAIL — see verdicts above."}`);
process.exit(pass ? 0 : 1);
