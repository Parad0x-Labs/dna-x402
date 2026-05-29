#!/usr/bin/env node
/**
 * Mainnet-beta write smoke — dark_proof_gate_lite
 *
 * Submits ONE real instruction to PmSCTuehX1MYxf8GNsGsUZySYTtqWAtuTt3N2xZLpw2
 * (dark_proof_gate_lite) on mainnet-beta using the CLI-configured keypair.
 *
 * Instruction: RecordVerifiedClaim
 *   discriminant = 0x00
 *   claim_hash   = SHA-256("dna-x402-mainnet-beta-smoke-2026-05-29-proofgate")
 *   statement_kind = 0x10 (ReceiptRedeem)
 *
 * Program behavior (IS_MAINNET_READY=false, stub):
 *   - Validates accounts and signer
 *   - Checks claim_record data_len == 0
 *   - Logs claim, returns Ok(())
 *   - Does NOT allocate or write to any account
 *   Cost: ~5000 lamports (tx fee only)
 *
 * Writes: evidence/mainnet/smoke-proofgate-write.json
 */

import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = join(__dirname, "..", "..");

// ── Constants ─────────────────────────────────────────────────────────────────
const PROGRAM_ID   = "PmSCTuehX1MYxf8GNsGsUZySYTtqWAtuTt3N2xZLpw2";
const RPC_URL      = "https://api.mainnet-beta.solana.com";
const STATEMENT_KIND_RECEIPT_REDEEM = 0x10;

// ── Deterministic smoke claim hash ────────────────────────────────────────────
const SMOKE_DOMAIN = "dna-x402-mainnet-beta-smoke-2026-05-29-proofgate";
const claimHash    = createHash("sha256").update(SMOKE_DOMAIN).digest(); // 32 bytes

// ── Build instruction data ────────────────────────────────────────────────────
// [discriminant=0x00][claim_hash 32 bytes][statement_kind 1 byte] = 34 bytes
const ixData = Buffer.concat([
  Buffer.from([0x00]),
  claimHash,
  Buffer.from([STATEMENT_KIND_RECEIPT_REDEEM]),
]);

console.log("\n=== Write Smoke: dark_proof_gate_lite (mainnet-beta) ===\n");
console.log("Program:    ", PROGRAM_ID);
console.log("Claim hash: ", claimHash.toString("hex"));
console.log("IX data:    ", ixData.toString("hex"), `(${ixData.length} bytes)`);
console.log("RPC:        ", RPC_URL);
console.log();

// ── Get CLI wallet address ────────────────────────────────────────────────────
let authority;
try {
  authority = execSync("solana address", { encoding: "utf8" }).trim();
  console.log("Authority:  ", authority);
} catch (err) {
  console.error("FAIL: Cannot get Solana CLI address:", err.message);
  process.exit(1);
}

// ── Derive a deterministic claim record account ───────────────────────────────
// We use the authority pubkey + claimHash bytes as seeds for a simple PDA-like
// deterministic address. The program doesn't verify PDA derivation in stub mode,
// so any fresh pubkey works. We use a hash to make it reproducible + non-collidable.
const claimRecordSeed = createHash("sha256")
  .update("claim-record-v1")
  .update(authority)
  .update(claimHash)
  .digest();

// Convert to a valid base58 pubkey representation using the @solana/web3.js ecosystem.
// We use a simpler approach: encode as base58 directly from 32 bytes.
// solana-keygen and CLI can do this for us, or we use the bundled bs58 if present.
// Fallback: use the claimHash itself as the "claim record" pubkey (valid 32-byte key).
// Since the program only checks data_len > 0 on it, any pubkey that doesn't yet have
// data on-chain will work.

// ── Build and submit tx via solana-cli transfer-with-instruction trick ─────────
// solana-cli doesn't have a raw instruction tool, so we use the @solana/web3.js
// approach from node. Check if @solana/web3.js is available.

let txSignature = null;
let submitErr   = null;

try {
  // Try to use @solana/web3.js from the workspace
  const web3Path = join(REPO_ROOT, "node_modules", "@solana", "web3.js");
  const { Connection, PublicKey, Transaction, TransactionInstruction, Keypair } =
    await import(join(web3Path, "lib", "index.esm.js")).catch(() => null) ??
    await import("@solana/web3.js");

  const connection = new Connection(RPC_URL, "confirmed");

  // Authority = CLI wallet (we read the keypair from the default path)
  const keyPath = execSync("solana config get | grep 'Keypair Path'", { encoding: "utf8", shell: true })
    .match(/Keypair Path:\s+(.+)/)?.[1]?.trim();

  if (!keyPath) throw new Error("Cannot determine keypair path from solana config.");
  console.log("Keypair:    ", keyPath);

  const { readFileSync } = await import("node:fs");
  const secret     = Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8")));
  const authorityKp = Keypair.fromSecretKey(secret);
  const authorityPk = authorityKp.publicKey;

  // Claim record account: hash of (authority + claimHash) → deterministic pubkey
  // Use the first 32 bytes of SHA-256("claim-record-v1" || authority || claimHash)
  const claimRecordPk = new PublicKey(claimRecordSeed);

  console.log("Claim record acct:", claimRecordPk.toBase58());

  const ix = new TransactionInstruction({
    programId: new PublicKey(PROGRAM_ID),
    keys: [
      { pubkey: claimRecordPk,  isSigner: false, isWritable: true },
      { pubkey: authorityPk,    isSigner: true,  isWritable: false },
    ],
    data: ixData,
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: authorityPk }).add(ix);
  tx.sign(authorityKp);

  console.log("\nSubmitting transaction...");
  txSignature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  console.log("TX signature:", txSignature);

  await connection.confirmTransaction({ signature: txSignature, blockhash, lastValidBlockHeight }, "confirmed");
  console.log("CONFIRMED ✓");
} catch (err) {
  submitErr = String(err.message ?? err);
  console.error("Submit error:", submitErr);
}

// ── Write evidence ────────────────────────────────────────────────────────────
const timestamp = new Date().toISOString();
const result = {
  schemaVersion: "1.0",
  generatedAt:   timestamp,
  program:       PROGRAM_ID,
  cluster:       "mainnet-beta",
  rpc:           RPC_URL,
  authority,
  claimHash:     claimHash.toString("hex"),
  smokeDomain:   SMOKE_DOMAIN,
  instructionBytes: ixData.toString("hex"),
  statementKind: `0x${STATEMENT_KIND_RECEIPT_REDEEM.toString(16)} (ReceiptRedeem)`,
  writeType:     txSignature ? "real-mainnet-tx" : "dry-run",
  txSignature:   txSignature ?? null,
  explorerUrl:   txSignature
    ? `https://explorer.solana.com/tx/${txSignature}?cluster=mainnet-beta`
    : null,
  status:        txSignature ? "CONFIRMED" : "FAILED",
  error:         submitErr ?? null,
  note: txSignature
    ? "Real mainnet-beta tx. dark_proof_gate_lite stub: validates accounts, logs claim, returns Ok(). No account allocation (IS_MAINNET_READY=false)."
    : "Transaction submission failed. See error field.",
};

mkdirSync(join(REPO_ROOT, "evidence", "mainnet"), { recursive: true });
writeFileSync(
  join(REPO_ROOT, "evidence", "mainnet", "smoke-proofgate-write.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log("\nEvidence: evidence/mainnet/smoke-proofgate-write.json");

if (!txSignature) {
  console.error("FAIL: No tx signature captured.");
  process.exit(1);
}
console.log(`\nPASS: Real mainnet write smoke confirmed.`);
console.log(`Explorer: https://explorer.solana.com/tx/${txSignature}?cluster=mainnet-beta`);
process.exit(0);
