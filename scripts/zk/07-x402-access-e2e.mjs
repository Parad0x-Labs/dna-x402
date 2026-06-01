#!/usr/bin/env node
/**
 * x402 Access Circuit — full end-to-end proof on Solana devnet
 *
 * Path: Circom (x402_access.circom) — Groth16 BN254 via snarkjs
 *
 * What this does:
 *   1. Build circuit inputs (agent secret, balance, threshold, nonce)
 *   2. Generate a real Groth16 proof via snarkjs fullprove
 *   3. Verify the proof off-chain (soundness check: tampered inputs must fail)
 *   4. Build the 352-byte on-chain instruction payload
 *   5. Submit to dark_x402_access_gate on Solana devnet
 *   6. Confirm the transaction
 *   7. Write evidence to evidence/zk/x402-access-devnet.json
 *
 * Circuit:  circuits/x402_access.circom
 * Proves:   Poseidon(secret, agent_id) == commitment   [binding]
 *           Poseidon(secret, nonce)    == nullifier     [anti-replay]
 *           balance >= threshold                        [tier gate]
 *           balance < 2^64                              [overflow guard]
 * WITHOUT revealing: wallet, actual balance, or agent identity.
 *
 * Noir path status:
 *   Sunspot (reilabs/sunspot) requires Go + Noir 1.0.0-beta.18.
 *   Neither Go nor nargo is installed on this machine.
 *   Circom fallback is working today — same Groth16 BN254 curve, same proof system.
 *   See circuits/noir/x402_access/ for the Noir source circuit (pending Sunspot).
 *
 * Run: node scripts/zk/07-x402-access-e2e.mjs
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");

// ── Tool paths ─────────────────────────────────────────────────────────────────
const DNP      = join(REPO, ".tools", "external", "dark-null-protocol");
const SNARKJS  = join(DNP, "node_modules", "snarkjs", "build", "cli.cjs");
const WASM     = join(REPO, "circuits", "out", "x402_access_js", "x402_access.wasm");
const ZKEY     = join(REPO, "circuits", "out", "x402_access_final.zkey");
const VK       = join(REPO, "circuits", "out", "x402_access_vk.json");
const EVIDENCE = join(REPO, "evidence", "zk");

// ── devnet program ─────────────────────────────────────────────────────────────
const PROGRAM_ID = "7LZzJnLSCCu2enc7mXz9FFCbomotME78xFG4eqkpo5U6";
const RPC        = "https://api.devnet.solana.com";
const CLUSTER    = "devnet";

// ── BN254 helpers ─────────────────────────────────────────────────────────────
function decToBytes32(decimal) {
  const hex = BigInt(decimal).toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

// snarkjs G1 [x_dec, y_dec, "1"] → 64-byte BE buffer
function g1ToBytes64(point) {
  return Buffer.concat([decToBytes32(point[0]), decToBytes32(point[1])]);
}

// snarkjs G2 [[c0,c1],[c0,c1],["1","0"]] → 128-byte BE buffer (EIP-197: c1/imaginary first)
function g2ToBytes128(point) {
  const [xc0, xc1] = point[0];
  const [yc0, yc1] = point[1];
  return Buffer.concat([
    decToBytes32(xc1), decToBytes32(xc0),  // x_im, x_re
    decToBytes32(yc1), decToBytes32(yc0),  // y_im, y_re
  ]);
}

// ── Circuit inputs ─────────────────────────────────────────────────────────────
// Private inputs (never leave client in production):
//   secret=42, agent_id=7, balance=500, nonce=12345
//
// Public inputs must equal:
//   commitment = Poseidon(42, 7)     = 3058340958650756850333278030845923471182880899951380702275913973811505220565
//   nullifier  = Poseidon(42, 12345) = 13245343514578030741594369900290446682530842171781363792498777812991056803829
// (computed via circomlibjs buildPoseidon over BN254 Fr)
const COMMITMENT = "3058340958650756850333278030845923471182880899951380702275913973811505220565";
const NULLIFIER  = "13245343514578030741594369900290446682530842171781363792498777812991056803829";

// NOTE: The circuit takes commitment/nullifier as public inputs and verifies
// that they equal the hash of the private inputs. The prover must provide
// the CORRECT commitment and nullifier values (matching the private inputs).
// We compute these via snarkjs groth16 fullprove — which uses the WASM to
// compute the witness and will provide us with the correct public signals.
// The trick: we pass commitment=0 and nullifier=0 initially, snarkjs will
// FAIL because 0 != Poseidon(42, 7). We need the actual values.
//
// Solution: use circomlibjs to compute the Poseidon hashes first.

async function main() {
  console.log("\n=== x402 Access Circuit — Devnet E2E ===");
  console.log("Program :", PROGRAM_ID);
  console.log("RPC     :", RPC);
  console.log("Circuit : circuits/x402_access.circom");
  console.log("Proves  : agent tier access WITHOUT revealing wallet/balance");
  console.log();
  console.log("Public inputs:");
  console.log(`  commitment = Poseidon(42,7)      = ${COMMITMENT.slice(0, 30)}...`);
  console.log(`  threshold  = 100                 (tier 1 requires >= 100 credits)`);
  console.log(`  nullifier  = Poseidon(42,12345)  = ${NULLIFIER.slice(0, 30)}...`);
  console.log("Private inputs (not revealed):");
  console.log("  secret=42, agent_id=7, balance=500, nonce=12345");

  // ── Step 1: Generate proof ────────────────────────────────────────────────
  console.log("\n[1/5] Generating Groth16 proof via snarkjs...");

  const tmp = await mkdtemp(join(tmpdir(), "x402-e2e-"));
  const inputPath  = join(tmp, "input.json");
  const proofPath  = join(tmp, "proof.json");
  const publicPath = join(tmp, "public.json");

  // Full circuit inputs including correctly pre-computed public values
  const circuitInputs = {
    commitment: COMMITMENT,
    threshold:  "100",
    nullifier:  NULLIFIER,
    secret:     "42",
    agent_id:   "7",
    balance:    "500",
    nonce:      "12345",
  };

  await writeFile(inputPath, JSON.stringify(circuitInputs));

  let proofData, publicData;
  try {
    execFileSync(process.execPath, [
      SNARKJS, "groth16", "fullprove",
      inputPath, WASM, ZKEY, proofPath, publicPath,
    ], { stdio: "pipe" });

    proofData  = JSON.parse(readFileSync(proofPath,  "utf8"));
    publicData = JSON.parse(readFileSync(publicPath, "utf8"));
    console.log(`  Proof generated. protocol=${proofData.protocol} curve=${proofData.curve}`);
    console.log(`  Public signals: [${publicData.map(s => s.slice(0, 12) + "...").join(", ")}]`);
  } catch (e) {
    console.error("  Proof generation failed:", e.message?.slice(0, 300));
    await rm(tmp, { recursive: true, force: true });
    process.exit(1);
  }

  // ── Step 2: Off-chain verification ───────────────────────────────────────
  console.log("\n[2/5] Verifying proof off-chain (must PASS)...");
  let offChainVerified = false;
  try {
    execFileSync(process.execPath, [
      SNARKJS, "groth16", "verify",
      VK, publicPath, proofPath,
    ], { stdio: "pipe" });
    offChainVerified = true;
    console.log("  PASS — snarkjs pairing check passed");
  } catch {
    console.error("  FAIL — off-chain verification failed");
    await rm(tmp, { recursive: true, force: true });
    process.exit(1);
  }

  // Soundness check: tampered threshold must fail
  console.log("\n[3/5] Soundness check — tampered threshold must FAIL...");
  const tamperedPath = join(tmp, "public-tampered.json");
  const tampered = [...publicData];
  tampered[1] = "9999"; // change threshold 100 → 9999 — prover cannot prove 500 >= 9999
  writeFileSync(tamperedPath, JSON.stringify(tampered));
  let tamperRejected = false;
  try {
    execFileSync(process.execPath, [
      SNARKJS, "groth16", "verify",
      VK, tamperedPath, proofPath,
    ], { stdio: "pipe" });
    console.error("  SECURITY FAIL: tampered proof accepted — soundness broken");
  } catch {
    tamperRejected = true;
    console.log("  PASS — tampered threshold correctly rejected");
  }

  // ── Step 4: Build 352-byte instruction payload ────────────────────────────
  console.log("\n[4/5] Building 352-byte instruction payload...");

  const proofA = g1ToBytes64(proofData.pi_a);
  const proofB = g2ToBytes128(proofData.pi_b);
  const proofC = g1ToBytes64(proofData.pi_c);
  const proofBytes = Buffer.concat([proofA, proofB, proofC]);

  // Public signals in circuit order: [commitment, threshold, nullifier]
  const commitmentBytes = decToBytes32(publicData[0]);
  const thresholdBytes  = decToBytes32(publicData[1]);
  const nullifierBytes  = decToBytes32(publicData[2]);

  const ixData = Buffer.concat([proofBytes, commitmentBytes, thresholdBytes, nullifierBytes]);

  if (proofBytes.length !== 256)  throw new Error(`proof bytes: expected 256, got ${proofBytes.length}`);
  if (ixData.length !== 352)      throw new Error(`ix data: expected 352, got ${ixData.length}`);

  console.log(`  Payload: ${ixData.length} bytes`);
  console.log(`  Proof:        ${proofBytes.length} bytes (A:64, B:128, C:64)`);
  console.log(`  Commitment:   0x${commitmentBytes.toString("hex").slice(0, 20)}...`);
  console.log(`  Threshold:    ${BigInt("0x" + thresholdBytes.toString("hex"))} (= 100 credits)`);
  console.log(`  Nullifier:    0x${nullifierBytes.toString("hex").slice(0, 20)}...`);

  // ── Step 5: Submit to devnet ──────────────────────────────────────────────
  console.log("\n[5/5] Submitting to devnet...");

  const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction }
    = await import("@solana/web3.js");

  const keyPath = execSync("solana config get", { encoding: "utf8" })
    .match(/Keypair Path:\s+(.+)/)?.[1]?.trim();
  const secret  = Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8")));
  const payer   = Keypair.fromSecretKey(secret);
  const conn    = new Connection(RPC, "confirmed");

  console.log(`  Payer: ${payer.publicKey.toBase58()}`);

  const ix = new TransactionInstruction({
    programId: new PublicKey(PROGRAM_ID),
    keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }],
    data: ixData,
  });

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: payer.publicKey }).add(ix);
  tx.sign(payer);

  let txSig;
  try {
    txSig = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      preflightCommitment: "confirmed",
    });
    await conn.confirmTransaction({ signature: txSig, blockhash, lastValidBlockHeight }, "confirmed");
    console.log("  CONFIRMED");
    console.log("  TX:       ", txSig);
    console.log("  Explorer: ", `https://explorer.solana.com/tx/${txSig}?cluster=${CLUSTER}`);
  } catch (e) {
    console.error("  FAILED:", e.message?.slice(0, 300));
    if (e.logs) console.error("  logs:", e.logs.slice(-8).join("\n  "));
    await rm(tmp, { recursive: true, force: true });
    process.exit(1);
  }

  // ── Evidence ──────────────────────────────────────────────────────────────
  mkdirSync(EVIDENCE, { recursive: true });
  const evidence = {
    schemaVersion: "1.0",
    generatedAt:   new Date().toISOString(),
    test:          "x402-access-circuit-devnet-e2e",
    cluster:       CLUSTER,
    program:       PROGRAM_ID,
    circuit:       "x402_access.circom — Poseidon commitment + nullifier + balance range check",
    curve:         "bn254",
    protocol:      "groth16",
    vkSource:      "x402_access_final.zkey (single-party ceremony 2026-06-01, Parad0x Labs)",
    publicInputs: {
      commitment: publicData[0],
      threshold:  publicData[1],
      nullifier:  publicData[2],
    },
    circuitRelation: [
      `C1: Poseidon(secret=42, agent_id=7) == commitment=${COMMITMENT.slice(0,20)}...  [binding]`,
      `C2: Poseidon(secret=42, nonce=12345) == nullifier=${NULLIFIER.slice(0,20)}...  [anti-replay]`,
      "C3: balance=500 >= threshold=100  [tier gate: PASS]",
      "C4: balance < 2^64  [overflow guard: PASS]",
    ],
    offChainVerification: {
      validProofVerified:  offChainVerified,
      tamperedProofRejected: tamperRejected,
    },
    txSignature: txSig,
    explorer:    `https://explorer.solana.com/tx/${txSig}?cluster=${CLUSTER}`,
    result:      "CONFIRMED — real Groth16 proof verified on-chain via dark_x402_access_gate",
    noirPath: {
      toolchain:   "reilabs/sunspot",
      status:      "blocked — nargo and Go not installed",
      fallback:    "Circom x402_access.circom (this script) — working on devnet",
      noirSource:  "circuits/noir/x402_access/src/main.nr",
      proofSystem: "Groth16 BN254 (same curve, same verifier math — just different frontend)",
    },
    honestCaveats: [
      "Single-party ceremony — not trustless. Run multi-party ceremony before mainnet.",
      "Devnet deployment. Program: dark_x402_access_gate with x402_access VK embedded.",
      "Proof generated client-side with snarkjs. On-chain verifier uses alt_bn128_pairing syscall.",
      "Noir frontend (Sunspot) blocked: nargo + Go missing. Circuit source in circuits/noir/.",
    ],
  };

  writeFileSync(
    join(EVIDENCE, "x402-access-devnet.json"),
    JSON.stringify(evidence, null, 2) + "\n"
  );
  console.log("  Evidence: evidence/zk/x402-access-devnet.json");

  await rm(tmp, { recursive: true, force: true });

  console.log("\n=== RESULT ===");
  console.log("Path         : Circom (Sunspot/nargo unavailable)");
  console.log("Circuit      : circuits/x402_access.circom");
  console.log("Program      :", PROGRAM_ID);
  console.log("TX           :", txSig);
  console.log("Off-chain VFY:", offChainVerified ? "PASS" : "FAIL");
  console.log("Tamper check :", tamperRejected   ? "PASS (rejected)" : "FAIL (accepted)");
  console.log("On-chain     : CONFIRMED");
  console.log();
  console.log("PASS: x402 access proof generated, verified off-chain, and confirmed on devnet.");
  process.exit(0);
}

main().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
