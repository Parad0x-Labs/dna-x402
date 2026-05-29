#!/usr/bin/env node
/**
 * Smoke test: verify dark_proof_gate_lite is live and readable on mainnet-beta.
 *
 * Read-only only — no transaction submitted.
 *
 * Why read-only: This smoke test proves the program is live and accessible
 * from the network. Full claim anchoring (writing a receipt PDA to the program)
 * requires a fee payer, a signed transaction, and a live program state. That
 * path is covered in integration tests (x402/tests/) and the devnet CI job.
 * Running a write transaction in this script would consume real SOL and add
 * unnecessary mainnet state with no additional diagnostic value at this stage.
 *
 * Writes:
 *   evidence/mainnet/smoke-receipt-anchor.json
 *   docs/MAINNET_SMOKE_TESTS.md   (appended or created)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

// @solana/web3.js is a CommonJS package — use createRequire for ESM compatibility
const require = createRequire(import.meta.url);
const solanaWeb3 = require("@solana/web3.js");
const { Connection, PublicKey } = solanaWeb3;

const PROOF_GATE_PROGRAM_ID = "PmSCTuehX1MYxf8GNsGsUZySYTtqWAtuTt3N2xZLpw2";
const RPC_URL = "https://api.mainnet-beta.solana.com";

async function main() {
  mkdirSync(join(REPO_ROOT, "evidence", "mainnet"), { recursive: true });
  mkdirSync(join(REPO_ROOT, "docs"), { recursive: true });

  console.log("=== Smoke: dark_proof_gate_lite (mainnet-beta, read-only) ===");
  console.log(`Program ID: ${PROOF_GATE_PROGRAM_ID}`);
  console.log(`RPC:        ${RPC_URL}`);
  console.log("");

  const connection = new Connection(RPC_URL, "confirmed");
  const programPubkey = new PublicKey(PROOF_GATE_PROGRAM_ID);

  let accountInfo;
  let slot;
  try {
    const result = await connection.getAccountInfoAndContext(programPubkey, "confirmed");
    accountInfo = result.value;
    slot = result.context.slot;
  } catch (err) {
    const evidence = {
      status: "failed",
      programId: PROOF_GATE_PROGRAM_ID,
      error: String(err.message ?? err),
      timestamp: new Date().toISOString(),
    };
    writeFileSync(
      join(REPO_ROOT, "evidence", "mainnet", "smoke-receipt-anchor.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
    console.error("FAIL: RPC error:", err.message ?? err);
    process.exit(1);
  }

  if (!accountInfo) {
    const evidence = {
      status: "failed",
      programId: PROOF_GATE_PROGRAM_ID,
      accountExists: false,
      error: "Account not found on mainnet-beta",
      timestamp: new Date().toISOString(),
    };
    writeFileSync(
      join(REPO_ROOT, "evidence", "mainnet", "smoke-receipt-anchor.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
    console.error("FAIL: Program account not found");
    process.exit(1);
  }

  const executable = accountInfo.executable;
  if (!executable) {
    const evidence = {
      status: "failed",
      programId: PROOF_GATE_PROGRAM_ID,
      accountExists: true,
      executable: false,
      error: "Account exists but is not executable",
      slot,
      timestamp: new Date().toISOString(),
    };
    writeFileSync(
      join(REPO_ROOT, "evidence", "mainnet", "smoke-receipt-anchor.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
    console.error("FAIL: Account is not executable");
    process.exit(1);
  }

  const timestamp = new Date().toISOString();
  const evidence = {
    status: "passed",
    programId: PROOF_GATE_PROGRAM_ID,
    accountExists: true,
    executable: true,
    lamports: accountInfo.lamports,
    owner: accountInfo.owner?.toBase58?.() ?? String(accountInfo.owner),
    slot,
    timestamp,
    note: "Read-only smoke test. No transaction submitted. Full anchoring covered by integration tests.",
  };

  writeFileSync(
    join(REPO_ROOT, "evidence", "mainnet", "smoke-receipt-anchor.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log("OK: Program is live and executable");
  console.log(`   Slot: ${slot}`);
  console.log(`   Owner: ${evidence.owner}`);
  console.log(`   Lamports: ${accountInfo.lamports}`);
  console.log("\nEvidence: evidence/mainnet/smoke-receipt-anchor.json");

  // Append to or create MAINNET_SMOKE_TESTS.md
  const mdPath = join(REPO_ROOT, "docs", "MAINNET_SMOKE_TESTS.md");
  const mdEntry = `
## dark_proof_gate_lite — Receipt Anchor Smoke

| Field | Value |
|-------|-------|
| Status | PASSED |
| Program ID | \`${PROOF_GATE_PROGRAM_ID}\` |
| Executable | yes |
| Slot | ${slot} |
| Timestamp | ${timestamp} |
| RPC | ${RPC_URL} |

> Read-only check. No transaction submitted — write-path anchoring is covered by integration tests.

`;
  if (existsSync(mdPath)) {
    const existing = readFileSync(mdPath, "utf8");
    if (!existing.includes(timestamp)) {
      writeFileSync(mdPath, existing + mdEntry);
    }
  } else {
    writeFileSync(mdPath, `# Mainnet Smoke Tests\n\n_Generated by scripts/post-mainnet/_\n` + mdEntry);
  }
  console.log("Markdown: docs/MAINNET_SMOKE_TESTS.md");
  process.exit(0);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
