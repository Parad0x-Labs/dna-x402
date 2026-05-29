#!/usr/bin/env node
/**
 * Optional USDC smoke test gate.
 *
 * This test is intentionally skipped unless USDC_SMOKE_ENABLED=1 is set.
 * A live USDC transfer on mainnet-beta requires a funded fee payer, a
 * specific USDC-funded wallet, and introduces real-money risk outside a
 * controlled test environment. It is NOT a launch blocker.
 *
 * USDC integration is validated in:
 *   - devnet CI (devnet-smoke job)
 *   - x402/tests/ integration suite
 *
 * Set USDC_SMOKE_ENABLED=1 in CI only when a dedicated test wallet is funded.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

mkdirSync(join(REPO_ROOT, "evidence", "mainnet"), { recursive: true });

const timestamp = new Date().toISOString();

if (process.env.USDC_SMOKE_ENABLED !== "1") {
  const result = {
    status: "skipped",
    reason: "USDC_SMOKE_SKIPPED_NOT_LAUNCH_BLOCKER",
    detail: "Set USDC_SMOKE_ENABLED=1 to run. Requires funded test wallet on mainnet-beta. Validated in devnet CI and integration tests.",
    generatedAt: timestamp,
  };

  writeFileSync(
    join(REPO_ROOT, "evidence", "mainnet", "usdc-smoke.json"),
    JSON.stringify(result, null, 2) + "\n",
  );

  console.log("USDC smoke: SKIPPED (USDC_SMOKE_ENABLED not set)");
  console.log("Evidence: evidence/mainnet/usdc-smoke.json");
  console.log("Not a launch blocker — USDC validated in devnet CI.");
  process.exit(0);
}

// If USDC_SMOKE_ENABLED=1, run a read-only balance check to verify
// the USDC mint is accessible — no transfer, just RPC connectivity.
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const { Connection, PublicKey } = require("@solana/web3.js");

const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RPC_URL = "https://api.mainnet-beta.solana.com";

console.log("=== USDC Smoke (read-only mint check) ===");
console.log(`USDC mint: ${USDC_MINT_MAINNET}`);

try {
  const connection = new Connection(RPC_URL, "confirmed");
  const mintPubkey = new PublicKey(USDC_MINT_MAINNET);
  const accountInfo = await connection.getAccountInfo(mintPubkey);

  if (!accountInfo) {
    throw new Error("USDC mint account not found on mainnet-beta");
  }

  const result = {
    status: "passed",
    check: "usdc-mint-reachable",
    mint: USDC_MINT_MAINNET,
    accountExists: true,
    lamports: accountInfo.lamports,
    owner: accountInfo.owner?.toBase58?.() ?? String(accountInfo.owner),
    note: "Read-only mint existence check. No transfer executed. Full USDC flow validated in devnet CI.",
    generatedAt: timestamp,
  };

  writeFileSync(
    join(REPO_ROOT, "evidence", "mainnet", "usdc-smoke.json"),
    JSON.stringify(result, null, 2) + "\n",
  );

  console.log("OK: USDC mint account confirmed on mainnet-beta");
  console.log("Evidence: evidence/mainnet/usdc-smoke.json");
  process.exit(0);
} catch (err) {
  const result = {
    status: "failed",
    error: String(err.message ?? err),
    generatedAt: timestamp,
  };
  writeFileSync(
    join(REPO_ROOT, "evidence", "mainnet", "usdc-smoke.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.error("FAIL:", err.message ?? err);
  process.exit(1);
}
