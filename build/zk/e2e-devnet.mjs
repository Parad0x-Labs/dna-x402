#!/usr/bin/env node
/**
 * Shielded pool v2 — DEVNET end-to-end.
 *
 *   init -> deposit x2 -> ZK-withdraw note#1 to a FRESH address
 *        -> assert recipient funded
 *        -> double-spend (replay nullifier) MUST revert
 *        -> wrong-root proof MUST revert
 *        -> wrong-recipient (valid proof, different recipient account) MUST revert
 *
 * A REAL circom proof (snarkjs) is verified by the on-chain alt_bn128 pairing
 * syscall against state the program built with the sol_poseidon syscall. Success
 * => on-chain Poseidon == circuit Poseidon, confirmed in-VM.
 *
 * Usage: node build/zk/e2e-devnet.mjs <PROGRAM_ID>
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, ComputeBudgetProgram,
} from "@solana/web3.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const CLUSTER = RPC.includes("mainnet") ? "mainnet-beta" : "devnet";
const PROGRAM_ID = new PublicKey(process.argv[2]);
const DENOM = 100_000_000; // 0.1 SOL per note

const conn = new Connection(RPC, "confirmed");
const keyPath = execFileSync("solana", ["config", "get"], { encoding: "utf8" })
  .match(/Keypair Path:\s+(.+)/)[1].trim();
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));

// Fresh authority per run → fresh pool PDA (note_count starts at 0), so the
// Merkle-path rebuild is deterministic and runs are idempotent. The fresh
// authority is funded from the wallet and acts as authority + depositor +
// fee-payer; the wallet just bankrolls it.
const authority = Keypair.generate();
const payer = authority; // signs init/deposit/withdraw fee-payer slots

const SEEDS = {
  config: Buffer.from("pool_config"),
  vault: Buffer.from("pool_vault"),
  leaf: Buffer.from("note_leaf"),
  nullifier: Buffer.from("nullifier"),
};
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

const [poolConfig] = PublicKey.findProgramAddressSync([SEEDS.config, authority.publicKey.toBuffer()], PROGRAM_ID);
const [poolVault] = PublicKey.findProgramAddressSync([SEEDS.vault, poolConfig.toBuffer()], PROGRAM_ID);
const noteLeafPda = (i) => PublicKey.findProgramAddressSync([SEEDS.leaf, poolConfig.toBuffer(), u64le(i)], PROGRAM_ID)[0];
const nullifierPda = (n) => PublicKey.findProgramAddressSync([SEEDS.nullifier, poolConfig.toBuffer(), Buffer.from(n, "hex")], PROGRAM_ID)[0];

const SYS = SystemProgram.programId;
const sysAccount = { pubkey: SYS, isSigner: false, isWritable: false };
const cuIx = (units) => ComputeBudgetProgram.setComputeUnitLimit({ units });

/**
 * Send a tx and return its ACTUAL on-chain execution result.
 *
 * A transaction that the program rejects still lands "confirmed" (it executed
 * and failed) — `confirmTransaction` resolving does NOT mean success. We must
 * inspect `meta.err`. `executed=true` only when meta.err is null.
 */
async function send(ixs, signers, label, { expectFail = false } = {}) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: payer.publicKey });
  for (const ix of ixs) tx.add(ix);
  tx.sign(...signers);

  let sig;
  try {
    sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  } catch (e) {
    // Could not even land the tx (e.g. blockhash expiry). Treat as a revert only
    // if we expected failure; otherwise rethrow.
    if (expectFail) {
      console.log(`  [${label}] reverted (not landed): ${e.message?.slice(0, 90)}`);
      return { executed: false, sig: e.signature ?? null, err: e.message };
    }
    console.error(`  [${label}] send FAILED: ${e.message?.slice(0, 200)}`);
    throw e;
  }

  // Fetch the executed transaction and read meta.err — the source of truth.
  let meta = null;
  for (let attempt = 0; attempt < 8 && !meta; attempt++) {
    const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (t?.meta) meta = t.meta;
    else await new Promise((r) => setTimeout(r, 800));
  }
  const err = meta?.err ?? null;
  const executed = err === null;
  const logs = meta?.logMessages ?? [];

  if (executed) {
    if (expectFail) {
      console.log(`  [${label}] UNEXPECTEDLY SUCCEEDED ${sig}`);
    } else {
      console.log(`  [${label}] succeeded ${sig}`);
    }
    return { executed: true, sig, logs };
  }
  // executed-and-failed
  if (expectFail) {
    const reason = logs.find((l) => /Custom|insufficient|failed|Error/i.test(l)) ?? JSON.stringify(err);
    console.log(`  [${label}] reverted as expected (err=${JSON.stringify(err)}) ${reason ? "| " + reason.slice(0, 80) : ""}`);
  } else {
    console.error(`  [${label}] ON-CHAIN ERROR ${JSON.stringify(err)} sig=${sig}`);
    if (logs.length) console.error("    logs:\n    " + logs.slice(-10).join("\n    "));
    throw new Error(`${label} failed on-chain: ${JSON.stringify(err)}`);
  }
  return { executed: false, sig, err, logs };
}

// ── instruction builders ────────────────────────────────────────────────────
const initIx = () => new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: poolConfig, isSigner: false, isWritable: true },
    { pubkey: poolVault, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    sysAccount,
  ],
  data: Buffer.concat([Buffer.from([0x00]), u64le(DENOM)]),
});

const depositIx = (leafIndex, commitmentHex) => new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: poolConfig, isSigner: false, isWritable: true },
    { pubkey: poolVault, isSigner: false, isWritable: true },
    { pubkey: noteLeafPda(leafIndex), isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    sysAccount,
  ],
  data: Buffer.concat([Buffer.from([0x01]), Buffer.from(commitmentHex, "hex")]),
});

// Withdraw data: 0x02 | nullifier(32) | root(32) | proof(256) | recipient(32)
// Accounts: [config, vault, nullifier_rec, recipient, fee_payer(signer), system]
const withdrawIx = (nullifierHex, rootHex, proofHex, recipient, recipientAccount) =>
  new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: poolConfig, isSigner: false, isWritable: true },
      { pubkey: poolVault, isSigner: false, isWritable: true },
      { pubkey: nullifierPda(nullifierHex), isSigner: false, isWritable: true },
      { pubkey: recipientAccount ?? recipient, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true }, // fee_payer / relayer
      sysAccount,
    ],
    data: Buffer.concat([
      Buffer.from([0x02]),
      Buffer.from(nullifierHex, "hex"),
      Buffer.from(rootHex, "hex"),
      Buffer.from(proofHex, "hex"),
      recipient.toBuffer(),
    ]),
  });

// ── on-chain root reader (parse PoolConfig: root at byte offset 44..76) ───────
async function readRoot() {
  const ai = await conn.getAccountInfo(poolConfig, "confirmed");
  if (!ai) throw new Error("pool_config not found");
  return Buffer.from(ai.data.slice(44, 76)).toString("hex");
}
async function readNoteCount() {
  const ai = await conn.getAccountInfo(poolConfig, "confirmed");
  return Number(Buffer.from(ai.data.slice(76, 84)).readBigUInt64LE());
}

// ── witness + proof helpers ──────────────────────────────────────────────────
function genSecretHex() {
  // high byte 0x05 keeps it well under the BN254 scalar modulus r.
  const b = randomBytes(32); b[0] = 0x05; return b.toString("hex");
}
function witnessSpec(scenario) {
  const tmp = mkdtempSync(join(tmpdir(), "swv2-"));
  const sIn = join(tmp, "scenario.json"), sOut = join(tmp, "spec.json");
  writeFileSync(sIn, JSON.stringify(scenario));
  execFileSync("cargo", ["run", "-q", "-p", "dark-shielded-pool-core", "--bin", "witness_spec",
    "--features", "witness-gen", "--", sIn, sOut], { cwd: REPO, stdio: "pipe" });
  const spec = JSON.parse(readFileSync(sOut, "utf8"));
  rmSync(tmp, { recursive: true, force: true });
  return spec;
}
function prove(spec) {
  const tmp = mkdtempSync(join(tmpdir(), "swv2-proof-"));
  const sIn = join(tmp, "spec.json"), sOut = join(tmp, "out.json");
  writeFileSync(sIn, JSON.stringify(spec));
  execFileSync(process.execPath, [join(HERE, "prove.mjs"), sIn, sOut], { stdio: "pipe" });
  const out = JSON.parse(readFileSync(sOut, "utf8"));
  rmSync(tmp, { recursive: true, force: true });
  return out;
}

// ── main ──────────────────────────────────────────────────────────────────────
const results = { scenarios: [] };
const record = (name, status, detail) => { results.scenarios.push({ name, status, ...detail }); };

async function main() {
  console.log(`\n=== shielded pool v2 — DEVNET e2e ===`);
  console.log(`program   ${PROGRAM_ID.toBase58()}`);
  console.log(`wallet    ${wallet.publicKey.toBase58()}`);
  console.log(`authority ${authority.publicKey.toBase58()} (fresh)`);
  console.log(`config    ${poolConfig.toBase58()}`);
  console.log(`vault     ${poolVault.toBase58()}`);

  // Fund the fresh authority from the wallet (deposits + rent + fees).
  console.log(`\n[fund] wallet -> authority 1 SOL`);
  {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: wallet.publicKey })
      .add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: authority.publicKey, lamports: 1_000_000_000 }));
    tx.sign(wallet);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    console.log(`  funded ${sig}`);
  }

  let initSig = null;
  console.log(`\n[init] InitPool denom=${DENOM}`);
  const r = await send([initIx()], [payer], "init");
  initSig = r.sig;

  // ── deposits: compute commitments via the Rust core (= circuit Poseidon) ────
  const baseIndex = await readNoteCount();
  console.log(`\n[deposit] current note_count = ${baseIndex}; depositing 2 notes`);
  // Two fresh secrets for this run; spend the SECOND so the tree has a real sibling.
  const sA = genSecretHex(), sB = genSecretHex();
  // build a witness spec just to get commitments (spendIndex points at our note)
  const poolKeyHex = Buffer.from(poolConfig.toBytes()).toString("hex");
  // We must replicate the on-chain leaf indices (baseIndex, baseIndex+1). The
  // commitment binds leaf_index, so we pass a leading run of zero-secret notes?
  // No — the tree already contains baseIndex prior leaves we don't know. But the
  // commitment for OUR note only needs ITS leaf_index; the Merkle PATH needs the
  // full tree. For a clean proof we require a FRESH pool (baseIndex==0). If the
  // pool pre-exists with notes, we still deposit but the path rebuild below uses
  // ONLY our two leaves assuming baseIndex==0. Enforce that for a deterministic e2e:
  if (baseIndex !== 0) {
    console.log(`  note_count=${baseIndex} != 0 — this e2e requires a fresh pool.`);
    console.log(`  Use a fresh authority/program to get baseIndex==0. Aborting cleanly.`);
    process.exit(3);
  }

  // commitments from the core (spend index 1, two secrets)
  const specForCommits = witnessSpec({ poolKeyHex, recipientHex: "05" + "00".repeat(31), spendIndex: 1, secretsHex: [sA, sB] });
  const commits = specForCommits.commitmentsHex;
  console.log(`  commit[0] ${commits[0]}`);
  console.log(`  commit[1] ${commits[1]}`);

  const dep0 = await send([cuIx(400_000), depositIx(0, commits[0])], [payer], "deposit#0");
  const dep1 = await send([cuIx(400_000), depositIx(1, commits[1])], [payer], "deposit#1");
  const rootAfter = await readRoot();
  console.log(`  on-chain root after 2 deposits: ${rootAfter}`);

  // ── build the REAL withdrawal proof for note #1 to a FRESH recipient ────────
  const recipient = Keypair.generate();
  const recipientHex = Buffer.from(recipient.publicKey.toBytes()).toString("hex");
  console.log(`\n[prove] fresh recipient ${recipient.publicKey.toBase58()}`);
  const spec = witnessSpec({ poolKeyHex, recipientHex, spendIndex: 1, secretsHex: [sA, sB] });

  // sanity: the Rust-computed root must equal the on-chain root
  const rustRoot = spec.expected.rootHex;
  console.log(`  rust root  ${rustRoot}`);
  console.log(`  chain root ${rootAfter}`);
  const rootsMatch = rustRoot === rootAfter;
  console.log(`  ROOT MATCH (on-chain Poseidon tree == circuit/core tree): ${rootsMatch}`);
  if (!rootsMatch) {
    record("root_consistency", "FAIL", { rustRoot, chainRoot: rootAfter });
    throw new Error("on-chain root != core/circuit root — Poseidon/tree mismatch");
  }
  record("root_consistency", "PASS", { root: rustRoot, deposits: [dep0.sig, dep1.sig] });

  const proof = prove(spec);
  console.log(`  snarkjs local verify: ${proof.localVerify}`);
  const nullifierHex = proof.publicInputsHex.nullifier;

  // recipient balance before
  const recBefore = await conn.getBalance(recipient.publicKey, "confirmed");

  // ── SCENARIO 1: valid withdraw ──────────────────────────────────────────────
  console.log(`\n[withdraw] valid proof -> fresh recipient`);
  const w = await send(
    [cuIx(1_400_000), withdrawIx(nullifierHex, rootAfter, proof.proof256Hex, recipient.publicKey)],
    [payer], "withdraw");
  const recAfter = await conn.getBalance(recipient.publicKey, "confirmed");
  const delta = recAfter - recBefore;
  console.log(`  recipient delta = ${delta} lamports (denom ${DENOM})`);
  if (w.executed && delta >= DENOM - 5000) {
    record("valid_withdraw", "PASS", { sig: w.sig, recipient: recipient.publicKey.toBase58(), delta, nullifier: nullifierHex });
  } else {
    record("valid_withdraw", "FAIL", { sig: w.sig, delta });
    throw new Error(`valid withdraw did not fund recipient (executed=${w.executed} delta=${delta})`);
  }

  // ── SCENARIO 2: double-spend (replay same nullifier) MUST revert ────────────
  console.log(`\n[double-spend] replay same nullifier -> expect revert`);
  const ds = await send(
    [cuIx(1_400_000), withdrawIx(nullifierHex, rootAfter, proof.proof256Hex, recipient.publicKey)],
    [payer], "double-spend", { expectFail: true });
  record("double_spend_rejected", ds.executed ? "FAIL" : "PASS",
    { reverted: !ds.executed, sig: ds.sig ?? null, err: ds.err ?? null });

  // ── SCENARIO 3: wrong-root proof MUST revert ────────────────────────────────
  // Re-prove the SAME note against a BOGUS root (not in the pool's recent set).
  console.log(`\n[wrong-root] proof against an unknown root -> expect revert`);
  const bogusRoot = "0a" + "11".repeat(31); // < r, never a real root
  const bogusSpec = { ...spec, merkleRoot: bigDecOfHex(bogusRoot) };
  // A proof against a bogus root would fail witness generation (root===hashes[depth]
  // constraint). So instead we submit the REAL proof but claim a different (unknown)
  // root in the instruction — the program's knows_root() check must reject it
  // before verification, OR verification fails because public input root differs.
  // Use a fresh nullifier-free note? The nullifier is already spent; use note #0.
  const spec0 = witnessSpec({ poolKeyHex, recipientHex, spendIndex: 0, secretsHex: [sA, sB] });
  const proof0 = prove(spec0);
  const wr = await send(
    [cuIx(1_400_000), withdrawIx(proof0.publicInputsHex.nullifier, bogusRoot, proof0.proof256Hex, recipient.publicKey)],
    [payer], "wrong-root", { expectFail: true });
  record("wrong_root_rejected", wr.executed ? "FAIL" : "PASS",
    { reverted: !wr.executed, sig: wr.sig ?? null, err: wr.err ?? null });

  // ── SCENARIO 4: wrong-recipient MUST revert ─────────────────────────────────
  // Take proof0 (bound to `recipient`) but submit it naming a DIFFERENT recipient.
  console.log(`\n[wrong-recipient] valid proof, different recipient account -> expect revert`);
  const attacker = Keypair.generate();
  const wc = await send(
    [cuIx(1_400_000), withdrawIx(proof0.publicInputsHex.nullifier, rootAfter, proof0.proof256Hex, attacker.publicKey)],
    [payer], "wrong-recipient", { expectFail: true });
  record("wrong_recipient_rejected", wc.executed ? "FAIL" : "PASS",
    { reverted: !wc.executed, sig: wc.sig ?? null, err: wc.err ?? null });

  // ── SCENARIO 5: the SAME proof0 with the CORRECT recipient succeeds ─────────
  console.log(`\n[withdraw#2] proof0 -> its bound recipient (sanity: real proof still verifies)`);
  const recBefore2 = await conn.getBalance(recipient.publicKey, "confirmed");
  const w2 = await send(
    [cuIx(1_400_000), withdrawIx(proof0.publicInputsHex.nullifier, rootAfter, proof0.proof256Hex, recipient.publicKey)],
    [payer], "withdraw#2");
  const recAfter2 = await conn.getBalance(recipient.publicKey, "confirmed");
  record("second_valid_withdraw", w2.executed && (recAfter2 - recBefore2) >= DENOM - 5000 ? "PASS" : "FAIL",
    { sig: w2.sig, delta: recAfter2 - recBefore2 });

  // ── evidence ────────────────────────────────────────────────────────────────
  const allPass = results.scenarios.every((s) => s.status === "PASS");
  const evidence = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    test: "dark_shielded_pool-v2-real-poseidon-zk-withdraw",
    cluster: CLUSTER,
    program: PROGRAM_ID.toBase58(),
    poolConfig: poolConfig.toBase58(),
    poolVault: poolVault.toBase58(),
    denominationLamports: DENOM,
    circuit: "shielded_withdraw_v2.circom (Poseidon commitment+nullifier, 20-level Poseidon Merkle, recipient+pool_id bound)",
    vk: "shielded_withdraw_v2_vk (SINGLE-PARTY / DEVNET PILOT / NOT TRUSTLESS)",
    initSig,
    onChainRootAfterDeposits: rootAfter,
    coreCircuitRoot: rustRoot,
    rootsMatch,
    scenarios: results.scenarios,
    overall: allPass ? "PASS" : "FAIL",
    keystone:
      "A real snarkjs Groth16 proof for shielded_withdraw_v2 verified ON-CHAIN " +
      "(alt_bn128 pairing syscall) against a Merkle root the program built with the " +
      "sol_poseidon syscall. The core/circuit-computed root byte-matched the on-chain " +
      "root. => on-chain Poseidon == circuit Poseidon, confirmed in-VM.",
    honestCaveats: [
      "SINGLE-PARTY trusted setup — NOT trustless. A multi-party ceremony with a pre-committed beacon is required before any trust/mainnet use.",
      "UNAUDITED devnet pilot. mainnet_ready=false throughout.",
      "Deposit binds leaf_index into the commitment, so the e2e requires a fresh pool (note_count starts at 0) for deterministic Merkle-path rebuild.",
    ],
    explorer: {
      program: `https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=${CLUSTER}`,
    },
  };
  mkdirSync(join(REPO, "evidence"), { recursive: true });
  const outPath = join(REPO, "evidence", "shielded-pool-devnet.json");
  writeFileSync(outPath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`\nEvidence: evidence/shielded-pool-devnet.json`);
  console.log(`OVERALL: ${evidence.overall}`);
  for (const s of results.scenarios) console.log(`  ${s.status.padEnd(4)} ${s.name}`);
  process.exit(allPass ? 0 : 1);
}

// decimal-of-hex (big) helper for bogus root spec (unused path but kept for clarity)
function bigDecOfHex(h) { return BigInt("0x" + h).toString(10); }

main().catch((e) => { console.error("\nFATAL:", e.message); process.exit(1); });
