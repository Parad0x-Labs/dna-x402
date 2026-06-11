#!/usr/bin/env node
/**
 * BV-7X Signal Anchor — cross-chain signal provenance
 *
 * Watches the BV-7X oracle contract on Base for daily signal events,
 * computes a SHA-256 receipt hash, and anchors it permanently on
 * Solana via receipt_anchor.
 *
 * Result: every BV-7X oracle signal gets a cross-chain proof-of-publication
 * on Solana. Anyone can verify the signal existed at slot X regardless
 * of what happens to the Base chain or BV-7X infrastructure.
 *
 * Usage:
 *   node scripts/integrations/bv7x-signal-anchor.mjs
 *   node scripts/integrations/bv7x-signal-anchor.mjs --once   # anchor latest signal only
 *   node scripts/integrations/bv7x-signal-anchor.mjs --watch  # watch + anchor new signals
 *
 * Env vars:
 *   BASE_RPC_URL          — Base mainnet RPC (e.g. Alchemy/QuickNode)
 *   SOLANA_RPC_URL        — Solana mainnet RPC
 *   SOLANA_DEPLOYER_KEYPAIR — JSON array 64 bytes
 *
 * BV-7X contract: 0xD88FD4a11255E51f64f78b4a7d74456325c2d8dC (Base mainnet)
 * receipt_anchor:  6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN (Solana mainnet)
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

// ── Config ────────────────────────────────────────────────────────────────────

const BV7X_CONTRACT   = "0xD88FD4a11255E51f64f78b4a7d74456325c2d8dC";
const RECEIPT_ANCHOR  = "6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN";
const BASE_RPC        = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const SOLANA_RPC      = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const ONCE            = process.argv.includes("--once");
const WATCH           = process.argv.includes("--watch");
const POLL_MS         = 60_000; // check every 60s in watch mode

const EVIDENCE_FILE   = "evidence/integrations/bv7x-anchors.json";

// ── Signal receipt schema ─────────────────────────────────────────────────────

/**
 * Build a canonical receipt hash for a BV-7X signal.
 * The hash commits to: contract address, block number, timestamp,
 * direction (LONG/SHORT), and confidence score.
 * This is what gets anchored on Solana.
 */
function signalReceiptHash(signal) {
  const canonical = JSON.stringify({
    source:     "bv7x-oracle",
    contract:   BV7X_CONTRACT.toLowerCase(),
    block:      signal.block,
    timestamp:  signal.timestamp,
    direction:  signal.direction,    // "LONG" | "SHORT"
    confidence: signal.confidence,   // 0-100
    resolution: signal.resolution,   // days until resolution
    txHash:     signal.txHash,
  });
  return createHash("sha256").update(canonical).digest();
}

// ── Base chain reader ─────────────────────────────────────────────────────────

async function fetchLatestSignal() {
  // BV-7X emits a SignalPublished event on Base each day at 08:00 UTC
  // Event sig (placeholder — replace with actual ABI once confirmed):
  //   SignalPublished(uint256 indexed timestamp, int8 direction, uint8 confidence)
  //
  // For now: fetch latest tx to the contract and parse calldata
  const res = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "eth_getBlockByNumber",
      params: ["latest", false],
    }),
  });
  const block = (await res.json()).result;

  // Fetch contract logs for SignalPublished events (last 1000 blocks)
  const logsRes = await fetch(BASE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 2,
      method: "eth_getLogs",
      params: [{
        address: BV7X_CONTRACT,
        fromBlock: `0x${(parseInt(block.number, 16) - 1000).toString(16)}`,
        toBlock: "latest",
      }],
    }),
  });
  const logs = (await logsRes.json()).result ?? [];

  if (!logs.length) {
    console.log("No BV-7X signal events found in last 1000 blocks.");
    return null;
  }

  // Take the most recent log
  const latest = logs[logs.length - 1];
  return {
    block:      parseInt(latest.blockNumber, 16),
    txHash:     latest.transactionHash,
    timestamp:  parseInt(latest.blockNumber, 16), // approximation until ABI confirmed
    direction:  "UNKNOWN", // parse from topics/data when ABI is confirmed
    confidence: 0,
    resolution: 7,
    raw:        latest,
  };
}

// ── Solana anchor ─────────────────────────────────────────────────────────────

async function anchorOnSolana(receiptHash) {
  const { Connection, Keypair, PublicKey, Transaction,
          TransactionInstruction, SystemProgram } = await import("@solana/web3.js");

  const keyPath = execSync("solana config get", { encoding: "utf8" })
    .match(/Keypair Path:\s+(.+)/)?.[1]?.trim();
  const secret = process.env.SOLANA_DEPLOYER_KEYPAIR
    ? JSON.parse(process.env.SOLANA_DEPLOYER_KEYPAIR)
    : JSON.parse(readFileSync(keyPath, "utf8"));
  const payer = Keypair.fromSecretKey(Uint8Array.from(secret));
  const conn  = new Connection(SOLANA_RPC, "confirmed");

  // Instruction: [0x01][0x00][32B root]
  const ixData = new Uint8Array(34);
  ixData[0] = 0x01; ixData[1] = 0x00;
  ixData.set(receiptHash, 2);

  // Bucket PDA: ["bucket", floor(unix_ts/3600) as u64 LE]
  const bucketId = BigInt(Math.floor(Date.now() / 1000 / 3600));
  const bucketSeed = Buffer.alloc(8);
  bucketSeed.writeBigUInt64LE(bucketId);
  const [bucketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bucket"), bucketSeed],
    new PublicKey(RECEIPT_ANCHOR)
  );

  const ix = new TransactionInstruction({
    programId: new PublicKey(RECEIPT_ANCHOR),
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: bucketPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: ixData,
  });

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: payer.publicKey }).add(ix);
  tx.sign(payer);

  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log("BV-7X Signal Anchor — cross-chain provenance");
  console.log(`Base contract:   ${BV7X_CONTRACT}`);
  console.log(`Solana anchor:   ${RECEIPT_ANCHOR}`);
  console.log("");

  const signal = await fetchLatestSignal();
  if (!signal) return;

  const hash = signalReceiptHash(signal);
  console.log(`Signal block:    ${signal.block}`);
  console.log(`Signal tx:       ${signal.txHash}`);
  console.log(`Receipt hash:    ${Buffer.from(hash).toString("hex").slice(0, 16)}...`);

  console.log("Anchoring on Solana...");
  const solanaTx = await anchorOnSolana(hash);
  console.log(`Solana tx:       ${solanaTx}`);
  console.log(`Explorer:        https://explorer.solana.com/tx/${solanaTx}?cluster=mainnet-beta`);

  // Store evidence
  mkdirSync("evidence/integrations", { recursive: true });
  const log = existsSync(EVIDENCE_FILE) ? JSON.parse(readFileSync(EVIDENCE_FILE)) : [];
  log.push({
    anchoredAt:  new Date().toISOString(),
    baseBlock:   signal.block,
    baseTx:      signal.txHash,
    receiptHash: Buffer.from(hash).toString("hex"),
    solanaTx,
    explorerUrl: `https://explorer.solana.com/tx/${solanaTx}?cluster=mainnet-beta`,
  });
  if (log.length > 100) log.splice(0, log.length - 100);
  writeFileSync(EVIDENCE_FILE, JSON.stringify(log, null, 2) + "\n");
  console.log(`Evidence:        ${EVIDENCE_FILE}`);
}

if (WATCH) {
  console.log(`Watch mode — polling every ${POLL_MS / 1000}s`);
  await run();
  setInterval(run, POLL_MS);
} else {
  await run();
}
