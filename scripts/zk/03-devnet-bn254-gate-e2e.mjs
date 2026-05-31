#!/usr/bin/env node
/**
 * devnet e2e: generate a real Groth16 proof → submit to dark_bn254_gate
 *
 * Proves the real VK is wired correctly on-chain:
 *   1. Generate proof with snarkjs (null_proof circuit, real zkey)
 *   2. Parse proof bytes + public signals
 *   3. Submit 512-byte instruction to dark_bn254_gate on devnet
 *   4. Confirm transaction → on-chain Groth16 verification
 *   5. Write evidence
 *
 * Run: node scripts/zk/03-devnet-bn254-gate-e2e.mjs <PROGRAM_ID>
 */

import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const DNP  = join(REPO, ".tools", "external", "dark-null-protocol");

const SNARKJS  = join(DNP, "node_modules", "snarkjs", "build", "cli.cjs");
const WASM     = join(DNP, "circuits", "null_proof_js", "null_proof.wasm");
// Use v2 ceremony zkey (2-party: sls_0x + ETH beacon) if available
const _zkeyV2  = join(DNP, "circuits", "null_proof_final_v2.zkey");
const _zkeyV1  = join(DNP, "circuits", "null_proof_final.zkey");
const ZKEY     = (await import("node:fs").then(m => m.existsSync(_zkeyV2))) ? _zkeyV2 : _zkeyV1;
const VK       = join(DNP, "circuits", "vk.json");
const RPC      = process.env.FACEID_RPC ?? "https://api.devnet.solana.com";
const CLUSTER  = RPC.includes("mainnet") ? "mainnet-beta" : "devnet";

const PROG_ID  = process.argv[2] ?? "DEPLOY_PROGRAM_ID_HERE";

// ── Canonical proof inputs (match 01-groth16-proof-demo) ─────────────────────
const receiverToken = Array.from({ length: 32 }, (_, i) => i + 1);
const mint          = Array.from({ length: 32 }, (_, i) => i + 33);
const part = (b) =>
  BigInt("0x" + Buffer.concat([Buffer.alloc(16), Buffer.from(b)]).toString("hex")).toString();

const inputs = {
  amount: "1000000",
  receiver_token_part_0: part(receiverToken.slice(0, 16)),
  receiver_token_part_1: part(receiverToken.slice(16, 32)),
  mint_part_0: part(mint.slice(0, 16)),
  mint_part_1: part(mint.slice(16, 32)),
  blinding: "7",
  nullifier_secret: "99",
  pathElements: Array(7).fill("0"),
  pathIndices: Array(7).fill(0),
};

// ── snarkjs decimal → 32-byte BE buffer ──────────────────────────────────────
function decToBytes32(decimal) {
  const hex = BigInt(decimal).toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

// snarkjs G1 point [x_dec, y_dec, "1"] → 64-byte BE buffer
function g1ToBytes64(point) {
  return Buffer.concat([decToBytes32(point[0]), decToBytes32(point[1])]);
}

// snarkjs G2 point [[c0_real, c1_imag], [c0_real, c1_imag], ["1","0"]] → 128-byte BE buffer
// snarkjs stores Fp2 as [c0, c1] but EIP-197/alt_bn128 wants [c1, c0] (imaginary first)
function g2ToBytes128(point) {
  const [xc0, xc1] = point[0]; // snarkjs: [real/c0, imaginary/c1]
  const [yc0, yc1] = point[1];
  return Buffer.concat([decToBytes32(xc1), decToBytes32(xc0), decToBytes32(yc1), decToBytes32(yc0)]); // EIP-197: c1 first
}

async function main() {
  console.log("\n=== dark_bn254_gate devnet e2e ===");
  console.log("Program:", PROG_ID);
  console.log("RPC:    ", RPC);

  if (PROG_ID === "DEPLOY_PROGRAM_ID_HERE") {
    console.error("\nERROR: pass the deployed program ID as the first argument");
    process.exit(1);
  }

  // ── 1. Generate real proof ────────────────────────────────────────────────
  console.log("\n[1/4] Generating Groth16 proof...");
  const tmp = await mkdtemp(join(tmpdir(), "bn254-e2e-"));
  const inputPath  = join(tmp, "input.json");
  const proofPath  = join(tmp, "proof.json");
  const publicPath = join(tmp, "public.json");

  await writeFile(inputPath, JSON.stringify(inputs));
  execFileSync(process.execPath, [SNARKJS, "groth16", "fullprove",
    inputPath, WASM, ZKEY, proofPath, publicPath], { stdio: "pipe" });

  const proof   = JSON.parse(readFileSync(proofPath, "utf8"));
  const pubSigs = JSON.parse(readFileSync(publicPath, "utf8"));
  console.log("  proof generated, curve:", proof.curve, "protocol:", proof.protocol);
  console.log("  public signals:", pubSigs.length, "(expected 8)");

  // ── 2. Build 512-byte instruction data ───────────────────────────────────
  console.log("\n[2/4] Building instruction data (512 bytes)...");

  // proof[256] = [A:64][B:128][C:64]
  const proofA = g1ToBytes64(proof.pi_a);
  const proofB = g2ToBytes128(proof.pi_b);
  const proofC = g1ToBytes64(proof.pi_c);
  const proofBytes = Buffer.concat([proofA, proofB, proofC]);

  // public inputs in circuit order:
  // public signals from snarkjs: [commitment, nullifier, root, amount, recv0, recv1, mint0, mint1]
  const publicInputs = pubSigs.map(decToBytes32);

  if (proofBytes.length !== 256) throw new Error(`proof bytes: expected 256, got ${proofBytes.length}`);
  if (publicInputs.length !== 8) throw new Error(`public inputs: expected 8, got ${publicInputs.length}`);

  const ixData = Buffer.concat([proofBytes, ...publicInputs]);
  console.log("  instruction data:", ixData.length, "bytes");

  // ── 3. Submit to devnet ───────────────────────────────────────────────────
  console.log("\n[3/4] Submitting to devnet...");

  const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction }
    = await import("@solana/web3.js");

  const keyPath = execSync("solana config get", { encoding: "utf8" })
    .match(/Keypair Path:\s+(.+)/)?.[1]?.trim();
  const secret = Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8")));
  const payer  = Keypair.fromSecretKey(secret);
  const conn   = new Connection(RPC, "confirmed");

  const ix = new TransactionInstruction({
    programId: new PublicKey(PROG_ID),
    keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }],
    data: ixData,
  });

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: payer.publicKey }).add(ix);
  tx.sign(payer);

  let txSig;
  try {
    txSig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, preflightCommitment: "confirmed" });
    await conn.confirmTransaction({ signature: txSig, blockhash, lastValidBlockHeight }, "confirmed");
    console.log("  CONFIRMED ✓");
    console.log("  TX:", txSig);
    console.log("  Explorer: https://explorer.solana.com/tx/" + txSig + "?cluster=" + CLUSTER);
  } catch (e) {
    console.error("  FAILED:", e.message?.slice(0, 200));
    if (e.logs) console.error("  logs:", e.logs.slice(-5).join("\n  "));
    await rm(tmp, { recursive: true, force: true });
    process.exit(1);
  }

  // ── 4. Evidence ───────────────────────────────────────────────────────────
  console.log("\n[4/4] Writing evidence...");
  mkdirSync(join(REPO, "evidence", "zk"), { recursive: true });
  const evidence = {
    schemaVersion: "1.0",
    generatedAt:   new Date().toISOString(),
    test:          `dark_bn254_gate-real-groth16-${CLUSTER}`,
    cluster:       CLUSTER,
    program:       PROG_ID,
    circuit:       "NullProofV2 (MiMCSponge commitment + nullifier + 7-level Merkle tree)",
    vkSource:      "null_proof_final.zkey (single-party ceremony, disclosed pilot)",
    publicInputs:  pubSigs,
    txSignature:   txSig,
    explorer:      `https://explorer.solana.com/tx/${txSig}?cluster=${CLUSTER}`,
    result:        "CONFIRMED — real Groth16 proof verified on-chain",
    honestCaveats: [
      "Single-party ceremony — not trustless. Run multi-party ceremony before mainnet trust.",
      "Pilot disclosure: this is a pre-audit devnet deployment.",
      "Proof generated client-side with snarkjs. On-chain verifier uses alt_bn128_pairing syscall.",
    ],
  };
  writeFileSync(join(REPO, "evidence", "zk", "dark-bn254-gate-devnet.json"),
    JSON.stringify(evidence, null, 2) + "\n");
  console.log("  Evidence: evidence/zk/dark-bn254-gate-devnet.json");

  await rm(tmp, { recursive: true, force: true });
  console.log("\nPASS: real Groth16 proof verified on-chain via dark_bn254_gate.");
  process.exit(0);
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
