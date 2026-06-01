#!/usr/bin/env node
/**
 * DNA x402 — Passive Income Streaming Demo
 *
 * Shows the full lifecycle of an agent earning from x402 calls and
 * auto-streaming proceeds to NULL stakers via the @parad0x_labs/stream-income SDK.
 *
 * What this proves:
 *   - Agent processes 1000 x402 calls at $0.001 each = $1.00 total earned
 *   - shouldStream() fires at the $0.50 threshold (500_000 atomic USDC)
 *   - PassiveIncomeReceipt is built, hash-sealed, and ready to anchor on-chain
 *   - At 1M calls/day = $1,000/day streaming to NULL stakers
 *
 * TDL #14: Three contracts, zero wiring between them:
 *   1. receipt_anchor  — anchors PassiveIncomeReceipt hashes on Solana
 *   2. SPL Token       — executes USDC stream transfers (buildStreamInstruction)
 *   3. Streamflow      — manages the auto-stream schedule (buildStreamflowSchedule)
 *
 * Usage:
 *   node scripts/demo/04-stream-income-demo.mjs
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Inline SDK (mirrors G:/DNA x402/packages/stream-income/src/index.ts)
// This demo runs stand-alone without requiring a build step.
// ---------------------------------------------------------------------------

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

function createSession(config, sessionId) {
  const id = sessionId ?? sha256(
    `${config.agentPubkey}|${Date.now()}|${Math.random()}`
  ).slice(0, 32);
  return {
    sessionId:    id,
    config,
    totalEarned:  0n,
    totalStreamed: 0n,
    pendingAmount: 0n,
    callCount:     0,
    lastStreamAt:  Math.floor(Date.now() / 1000),
    streamTxs:     [],
  };
}

function recordEarning(session, amountAtomic, receiptHash) {
  if (!/^[0-9a-f]{64}$/i.test(receiptHash)) {
    throw new Error(`recordEarning: invalid receiptHash "${receiptHash.slice(0, 20)}…"`);
  }
  return {
    ...session,
    totalEarned:   session.totalEarned   + amountAtomic,
    pendingAmount: session.pendingAmount + amountAtomic,
    callCount:     session.callCount     + 1,
  };
}

function shouldStream(session) {
  const nowSec = Math.floor(Date.now() / 1000);
  const enoughPending  = session.pendingAmount >= BigInt(session.config.minStreamAmount);
  const cooldownElapsed = nowSec - session.lastStreamAt >= session.config.streamIntervalSeconds;
  return enoughPending && cooldownElapsed;
}

function buildStreamflowSchedule(config, estimatedCallsPerDay = 10_000) {
  const dailyAmountAtomic = config.ratePerCall * estimatedCallsPerDay;
  return {
    recipient:               config.beneficiary,
    amount:                  dailyAmountAtomic,
    period:                  86400,
    cliff:                   0,
    cliffAmount:             0,
    mint:                    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    start:                   Math.floor(Date.now() / 1000),
    name:                    `NULL staker passive income — ${config.agentPubkey.slice(0, 8)}`,
    canTopup:                true,
    transferableBySender:    false,
    transferableByRecipient: false,
    partner:                 "parad0x_labs_dna_x402",
  };
}

function buildPassiveIncomeReceipt(session, periodStart) {
  const periodEnd = Math.floor(Date.now() / 1000);
  const preimage = [
    session.sessionId,
    session.totalEarned.toString(),
    session.totalStreamed.toString(),
    session.config.beneficiary,
    String(periodStart),
    String(periodEnd),
  ].join("|");
  const receiptHash = sha256(preimage);
  return {
    sessionId:    session.sessionId,
    totalEarned:  session.totalEarned,
    totalStreamed: session.totalStreamed,
    beneficiary:  session.config.beneficiary,
    periodStart,
    periodEnd,
    receiptHash,
  };
}

// ---------------------------------------------------------------------------
// Demo config
// ---------------------------------------------------------------------------

const AGENT_PUBKEY     = "AgentAlpha111111111111111111111111111111111111";
const BENEFICIARY      = "NullStakerVault11111111111111111111111111111111";

//  $0.001 per call = 1000 atomic USDC (6 decimals → 1_000 = 0.001000 USDC)
const RATE_PER_CALL    = 1_000;     // atomic USDC per x402 call

// Stream at $0.50 threshold to avoid dust
const MIN_STREAM       = 500_000;   // 0.50 USDC in atomic units

// Stream at most every 3600 s (1 hour) — set to 0 for immediate demo
const STREAM_INTERVAL  = 0;

const TOTAL_CALLS      = 1_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fmt = (n) => `${n}`;
const usdcDisplay = (atomic) => (Number(atomic) / 1_000_000).toFixed(6);
const log = (step, msg) => console.log(`\n  [${step}] ${msg}`);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("\n╔══════════════════════════════════════════════════════════╗");
console.log("║  DNA x402 — Passive Income Streaming Demo                ║");
console.log("║  1000 x402 calls → $1 earned → streamed to NULL stakers  ║");
console.log("╚══════════════════════════════════════════════════════════╝");

// 1. Create session
const config = {
  agentPubkey:           AGENT_PUBKEY,
  beneficiary:           BENEFICIARY,
  ratePerCall:           RATE_PER_CALL,
  streamIntervalSeconds: STREAM_INTERVAL,
  minStreamAmount:       MIN_STREAM,
  currency:              "USDC",
};

const periodStart = Math.floor(Date.now() / 1000);
let session       = createSession(config, "demo-session-tdl14-001");

log("CONFIG", `Agent:       ${AGENT_PUBKEY.slice(0, 20)}…`);
log("CONFIG", `Beneficiary: ${BENEFICIARY.slice(0, 20)}… (NULL staker vault)`);
log("CONFIG", `Rate:        ${RATE_PER_CALL} atomic USDC / call  (= $0.001000 USDC)`);
log("CONFIG", `Min stream:  ${MIN_STREAM} atomic USDC          (= $${usdcDisplay(MIN_STREAM)} USDC)`);
log("CONFIG", `Interval:    ${STREAM_INTERVAL}s`);

// 2. Simulate 1000 x402 calls
log("SIM", `Simulating ${TOTAL_CALLS} x402 calls…`);

const streamEvents = [];

for (let i = 1; i <= TOTAL_CALLS; i++) {
  // Generate a synthetic receipt hash for each call
  const receiptHash = sha256(`x402-call-${i}-agent-${AGENT_PUBKEY}-ts-${Date.now()}`);

  session = recordEarning(session, BigInt(RATE_PER_CALL), receiptHash);

  // Check stream trigger after every call
  if (shouldStream(session)) {
    const streamAmount  = session.pendingAmount;
    const fakeTxSig     = sha256(`stream-tx-${session.callCount}-${Date.now()}`).slice(0, 64);

    streamEvents.push({
      callNumber:    i,
      streamAmount,
      txSig:         fakeTxSig,
      totalStreamed:  session.totalStreamed + streamAmount,
    });

    log(
      "STREAM",
      `TRIGGERED at call #${i} — streaming ${streamAmount} atomic USDC` +
      ` (= $${usdcDisplay(streamAmount)}) to NULL staker vault`
    );
    log("STREAM", `  Synthetic tx sig: ${fakeTxSig.slice(0, 32)}…`);

    // Advance session state post-stream
    session = {
      ...session,
      totalStreamed:  session.totalStreamed  + streamAmount,
      pendingAmount:  0n,
      lastStreamAt:   Math.floor(Date.now() / 1000),
      streamTxs:      [...session.streamTxs, fakeTxSig],
    };
  }
}

log("SIM", `All ${TOTAL_CALLS} calls processed.`);

// 3. Show session totals
console.log("\n  ── Session Totals ──────────────────────────────────────────");
console.log(`     callCount:    ${session.callCount}`);
console.log(`     totalEarned:  ${session.totalEarned} atomic USDC   (= $${usdcDisplay(session.totalEarned)})`);
console.log(`     totalStreamed:${session.totalStreamed} atomic USDC  (= $${usdcDisplay(session.totalStreamed)})`);
console.log(`     pendingAmount:${session.pendingAmount} atomic USDC  (= $${usdcDisplay(session.pendingAmount)} — below threshold, not yet streamed)`);
console.log(`     streamTxs:    ${session.streamTxs.length} disbursement(s)`);

// 4. Build Streamflow schedule
const schedule = buildStreamflowSchedule(config, 1_000_000);
log("STREAMFLOW", `Schedule for 1M calls/day:`);
console.log(`     recipient:  ${schedule.recipient.slice(0, 24)}…`);
console.log(`     amount:     ${schedule.amount.toLocaleString()} atomic USDC/day  (= $${(schedule.amount / 1_000_000).toFixed(2)}/day)`);
console.log(`     period:     ${schedule.period}s (24h)`);
console.log(`     cliff:      ${schedule.cliff}s (none — stream starts immediately)`);
console.log(`     mint:       USDC mainnet`);
console.log(`     partner:    ${schedule.partner}`);

// 5. Build PassiveIncomeReceipt
const receipt = buildPassiveIncomeReceipt(session, periodStart);

log("RECEIPT", `PassiveIncomeReceipt built:`);
console.log(`     sessionId:    ${receipt.sessionId}`);
console.log(`     totalEarned:  ${receipt.totalEarned} atomic USDC   (= $${usdcDisplay(receipt.totalEarned)})`);
console.log(`     totalStreamed:${receipt.totalStreamed} atomic USDC  (= $${usdcDisplay(receipt.totalStreamed)})`);
console.log(`     beneficiary:  ${receipt.beneficiary.slice(0, 24)}…`);
console.log(`     periodStart:  ${receipt.periodStart}  (Unix s)`);
console.log(`     periodEnd:    ${receipt.periodEnd}  (Unix s)`);
console.log(`     receiptHash:  ${receipt.receiptHash}`);

log("ANCHOR", `Receipt hash ${receipt.receiptHash.slice(0, 32)}… ready to anchor via receipt_anchor program.`);
log("ANCHOR", `  Program: 6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN (Solana mainnet)`);

// 6. Scale projection
console.log("\n  ── Scale Projection ────────────────────────────────────────");
const callRates = [
  { label: "1K calls/day",   calls: 1_000 },
  { label: "10K calls/day",  calls: 10_000 },
  { label: "100K calls/day", calls: 100_000 },
  { label: "1M calls/day",   calls: 1_000_000 },
  { label: "10M calls/day",  calls: 10_000_000 },
];

for (const { label, calls } of callRates) {
  const dailyAtomic = calls * RATE_PER_CALL;
  const dailyUSDC   = dailyAtomic / 1_000_000;
  const yearlyUSDC  = dailyUSDC * 365;
  console.log(
    `     ${label.padEnd(18)} → $${dailyUSDC.toFixed(2).padStart(10)}/day` +
    `  ($${yearlyUSDC.toLocaleString("en-US", { maximumFractionDigits: 0 })}/yr streaming to NULL stakers)`
  );
}

console.log("\n  ─────────────────────────────────────────────────────────────");
console.log("  At 1M calls/day = $1,000/day streaming to NULL stakers.");
console.log("  At 10M calls/day = $10,000/day — protocol earns, stakers earn.");
console.log("  Three contracts. Zero wiring. Pure math.\n");

// 7. Verify receipt hash integrity
const recomputed = createHash("sha256").update([
  receipt.sessionId,
  receipt.totalEarned.toString(),
  receipt.totalStreamed.toString(),
  receipt.beneficiary,
  String(receipt.periodStart),
  String(receipt.periodEnd),
].join("|"), "utf8").digest("hex");

const hashOk = recomputed === receipt.receiptHash;
log("VERIFY", `Receipt hash integrity: ${hashOk ? "PASS" : "FAIL"}`);
if (!hashOk) {
  console.error("  CRITICAL: hash mismatch — receipt tampered.");
  process.exit(1);
}

console.log("\n  Demo complete.");
