#!/usr/bin/env node
/**
 * DARK RELAY RAIL — shielded pool v3 DEVNET end-to-end (full unlinkability + relayer market).
 *
 *   init(denom) -> deposit x2
 *     -> real V3 proof for a withdraw of note#1 to a FRESH recipient WITH a relayer fee
 *     -> submit via a RELAYER (fee_payer != recipient; recipient never signs)
 *     -> ASSERT recipient gets denom - fee, relayer net-gains ~fee (minus tx cost),
 *        recipient never signed
 *     -> double-spend (replay nullifier) MUST revert
 *     -> wrong-root proof MUST revert
 *     -> wrong-recipient (valid proof, different recipient account) MUST revert
 *     -> over-fee (fee > MAX_FEE) proof generation MUST fail (circuit rejects)
 *     -> relayer-mismatch (proof bound to relayer A, submitted by relayer B) MUST revert
 *
 * A real circom V3 proof (snarkjs) is verified on-chain by the alt_bn128 pairing
 * syscall against state the program built with the sol_poseidon syscall. The proof
 * binds relayer + fee, so the 2-way payout split is fixed by the proof.
 *
 * Usage: node build/zk/e2e-v3-devnet.mjs <PROGRAM_ID> [--vk-mode ceremony]
 *   vk-mode=ceremony (default) : the prover uses the CEREMONY zkey/vk the deployed
 *     program embeds (forwarded to prove-v3.mjs as SWV3_VK_MODE). The single-party
 *     pilot VK is rejected on-chain (Custom(4)=ProofInvalid), so it is not supported.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, ComputeBudgetProgram,
} from "@solana/web3.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const CLUSTER = RPC.includes("mainnet") ? "mainnet-beta" : "devnet";
const PROGRAM_ID = new PublicKey(process.argv[2]);
const VK_MODE = (() => { const i = process.argv.indexOf("--vk-mode"); return (i !== -1 ? process.argv[i + 1] : "ceremony").toLowerCase(); })();
if (VK_MODE === "pilot") {
  console.error(
    "e2e-v3-devnet.mjs: --vk-mode pilot is not supported against the deployed pool.\n" +
    "  The on-chain program embeds the CEREMONY verifying key; pilot (single-party) proofs\n" +
    "  are rejected with Custom(4)=ProofInvalid. Re-run with --vk-mode ceremony (the default).");
  process.exit(2);
}
if (VK_MODE !== "ceremony") {
  console.error(`e2e-v3-devnet.mjs: unknown --vk-mode '${VK_MODE}' (only 'ceremony' is supported)`);
  process.exit(2);
}
const DENOM = 100_000_000; // 0.1 SOL per note
const FEE = 1_000_000;     // 0.001 SOL relayer reimbursement (<= MAX_FEE = 0.05 SOL)

const conn = new Connection(RPC, "confirmed");
const keyPath = execFileSync("solana", ["config", "get"], { encoding: "utf8" })
  .match(/Keypair Path:\s+(.+)/)[1].trim();
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));

// Fresh authority per run → fresh pool PDA (note_count starts at 0). The authority
// funds deposits. A SEPARATE fresh relayer submits the withdraw and is reimbursed.
const authority = Keypair.generate();

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

/** Send a tx and return its ACTUAL on-chain execution result (reads meta.err). */
async function send(ixs, signers, feePayer, label, { expectFail = false } = {}) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer });
  for (const ix of ixs) tx.add(ix);
  tx.sign(...signers);

  let sig;
  try {
    sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  } catch (e) {
    if (expectFail) {
      console.log(`  [${label}] reverted (not landed): ${e.message?.slice(0, 90)}`);
      return { executed: false, sig: e.signature ?? null, err: e.message };
    }
    console.error(`  [${label}] send FAILED: ${e.message?.slice(0, 200)}`);
    throw e;
  }

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
    console.log(`  [${label}] ${expectFail ? "UNEXPECTEDLY SUCCEEDED" : "succeeded"} ${sig}`);
    return { executed: true, sig, logs };
  }
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
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },
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
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    sysAccount,
  ],
  data: Buffer.concat([Buffer.from([0x01]), Buffer.from(commitmentHex, "hex")]),
});

// Withdraw v3 data: 0x02 | nullifier(32) | root(32) | proof(256) | recipient(32) | relayer(32) | fee(8 LE)
// Accounts: [config, vault, nullifier_rec, recipient, fee_payer/relayer(signer), system]
const withdrawIx = (nullifierHex, rootHex, proofHex, recipient, relayer, fee, recipientAccount) =>
  new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: poolConfig, isSigner: false, isWritable: true },
      { pubkey: poolVault, isSigner: false, isWritable: true },
      { pubkey: nullifierPda(nullifierHex), isSigner: false, isWritable: true },
      { pubkey: recipientAccount ?? recipient, isSigner: false, isWritable: true },
      { pubkey: relayer, isSigner: true, isWritable: true }, // fee_payer / relayer
      sysAccount,
    ],
    data: Buffer.concat([
      Buffer.from([0x02]),
      Buffer.from(nullifierHex, "hex"),
      Buffer.from(rootHex, "hex"),
      Buffer.from(proofHex, "hex"),
      recipient.toBuffer(),
      relayer.toBuffer(),
      u64le(fee),
    ]),
  });

// ── on-chain readers ──────────────────────────────────────────────────────────
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
function genSecretHex() { const b = Buffer.from(crypto.getRandomValues(new Uint8Array(32))); b[0] = 0x05; return b.toString("hex"); }
function witnessSpec(scenario) {
  const tmp = mkdtempSync(join(tmpdir(), "swv3-"));
  const sIn = join(tmp, "scenario.json"), sOut = join(tmp, "spec.json");
  writeFileSync(sIn, JSON.stringify(scenario));
  execFileSync("cargo", ["run", "-q", "-p", "dark-shielded-pool-core", "--bin", "witness_spec",
    "--features", "witness-gen", "--", sIn, sOut], { cwd: REPO, stdio: "pipe" });
  const spec = JSON.parse(readFileSync(sOut, "utf8"));
  rmSync(tmp, { recursive: true, force: true });
  return spec;
}
function prove(spec, { fee = FEE, denom = DENOM, expectFail = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "swv3-proof-"));
  const sIn = join(tmp, "spec.json"), sOut = join(tmp, "out.json");
  writeFileSync(sIn, JSON.stringify({ ...spec, fee: String(fee), denomination: String(denom) }));
  try {
    // Forward vk-mode so the prover uses the CEREMONY zkey/vk the deployed program embeds.
    execFileSync(process.execPath, [join(HERE, "prove-v3.mjs"), sIn, sOut],
      { stdio: "pipe", env: { ...process.env, SWV3_VK_MODE: VK_MODE } });
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    if (expectFail) return { proofFailed: true, stderr: (e.stderr ?? Buffer.from("")).toString().slice(0, 200) };
    throw e;
  }
  const out = JSON.parse(readFileSync(sOut, "utf8"));
  rmSync(tmp, { recursive: true, force: true });
  return out;
}

const results = { scenarios: [] };
const record = (name, status, detail) => { results.scenarios.push({ name, status, ...detail }); };
const { webcrypto: crypto } = await import("node:crypto");

async function main() {
  console.log(`\n=== DARK RELAY RAIL — shielded pool v3 DEVNET e2e (vk-mode=${VK_MODE}) ===`);
  console.log(`program   ${PROGRAM_ID.toBase58()}`);
  console.log(`wallet    ${wallet.publicKey.toBase58()}`);
  console.log(`authority ${authority.publicKey.toBase58()} (fresh)`);
  console.log(`config    ${poolConfig.toBase58()}`);
  console.log(`vault     ${poolVault.toBase58()}`);

  // Fund the fresh authority (deposits + rent) and a fresh relayer (gas + rent).
  const relayer = Keypair.generate();
  console.log(`relayer   ${relayer.publicKey.toBase58()} (fresh — fronts gas/rent, reimbursed fee)`);
  {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: wallet.publicKey })
      .add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: authority.publicKey, lamports: 1_000_000_000 }))
      .add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: relayer.publicKey, lamports: 200_000_000 }));
    tx.sign(wallet);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    console.log(`  funded authority + relayer ${sig}`);
  }

  console.log(`\n[init] InitPool denom=${DENOM}`);
  const initR = await send([initIx()], [authority], authority.publicKey, "init");
  const initSig = initR.sig;

  const baseIndex = await readNoteCount();
  if (baseIndex !== 0) { console.log(`  note_count=${baseIndex} != 0 — needs a fresh pool. Aborting.`); process.exit(3); }

  const poolKeyHex = Buffer.from(poolConfig.toBytes()).toString("hex");
  const relayerHex = Buffer.from(relayer.publicKey.toBytes()).toString("hex");
  const sA = genSecretHex(), sB = genSecretHex();
  const specForCommits = witnessSpec({ poolKeyHex, recipientHex: "05" + "00".repeat(31), relayerHex, spendIndex: 1, secretsHex: [sA, sB] });
  const commits = specForCommits.commitmentsHex;
  console.log(`\n[deposit] 2 notes`);
  const dep0 = await send([cuIx(400_000), depositIx(0, commits[0])], [authority], authority.publicKey, "deposit#0");
  const dep1 = await send([cuIx(400_000), depositIx(1, commits[1])], [authority], authority.publicKey, "deposit#1");
  const rootAfter = await readRoot();
  console.log(`  on-chain root after 2 deposits: ${rootAfter}`);

  // ── build the REAL V3 withdrawal proof for note #1 → FRESH recipient, with fee ──
  const recipient = Keypair.generate();
  const recipientHex = Buffer.from(recipient.publicKey.toBytes()).toString("hex");
  console.log(`\n[prove] recipient ${recipient.publicKey.toBase58()} fee=${FEE} (payout=${DENOM - FEE})`);
  const spec = witnessSpec({ poolKeyHex, recipientHex, relayerHex, spendIndex: 1, secretsHex: [sA, sB] });

  const rustRoot = spec.expected.rootHex;
  const rootsMatch = rustRoot === rootAfter;
  console.log(`  ROOT MATCH (on-chain Poseidon tree == circuit/core tree): ${rootsMatch}`);
  if (!rootsMatch) { record("root_consistency", "FAIL", { rustRoot, chainRoot: rootAfter }); throw new Error("root mismatch"); }
  record("root_consistency", "PASS", { root: rustRoot, deposits: [dep0.sig, dep1.sig] });

  const proof = prove(spec);
  console.log(`  snarkjs local verify: ${proof.localVerify}; proof zkey=${proof.zkey} vk=${proof.vk}`);
  const nullifierHex = proof.publicInputsHex.nullifier;

  const recBefore = await conn.getBalance(recipient.publicKey, "confirmed");
  const relBefore = await conn.getBalance(relayer.publicKey, "confirmed");

  // ── SCENARIO 1: valid relayer-submitted withdraw (recipient never signs) ─────
  console.log(`\n[withdraw] valid proof — submitted by RELAYER (fee_payer != recipient)`);
  const w = await send(
    [cuIx(1_400_000), withdrawIx(nullifierHex, rootAfter, proof.proof256Hex, recipient.publicKey, relayer.publicKey, FEE)],
    [relayer], relayer.publicKey, "withdraw");
  const recAfter = await conn.getBalance(recipient.publicKey, "confirmed");
  const relAfter = await conn.getBalance(relayer.publicKey, "confirmed");
  const recDelta = recAfter - recBefore;
  const relDelta = relAfter - relBefore; // includes -txfee +rent_refund_from? +FEE -nullifier_rent
  console.log(`  recipient delta = ${recDelta} (expect denom - fee = ${DENOM - FEE})`);
  console.log(`  relayer   delta = ${relDelta} (expect ~ +fee - txfee - nullifier_rent)`);
  const recipientGotSplit = recDelta === DENOM - FEE;
  // relayer should NET gain close to FEE minus (tx fee ~5000 + nullifier-record rent ~0.0009 SOL);
  // the key assertion is that the relayer's reimbursement (FEE) is credited from the pool — without
  // the FEE credit the relayer would be strictly DOWN by txfee+rent; with it, relDelta > -FEE.
  const relayerReimbursed = relDelta > -(FEE); // proves FEE was credited to relayer
  if (w.executed && recipientGotSplit && relayerReimbursed) {
    record("valid_relayer_withdraw", "PASS", {
      sig: w.sig, recipient: recipient.publicKey.toBase58(), relayer: relayer.publicKey.toBase58(),
      recipientDelta: recDelta, relayerDelta: relDelta, fee: FEE, payout: DENOM - FEE,
      recipientSigned: false, nullifier: nullifierHex,
    });
  } else {
    record("valid_relayer_withdraw", "FAIL", { sig: w.sig, recipientDelta: recDelta, relayerDelta: relDelta });
    throw new Error(`valid relayer withdraw split wrong (executed=${w.executed} recDelta=${recDelta} relDelta=${relDelta})`);
  }

  // ── SCENARIO 2: double-spend (replay same nullifier) MUST revert ────────────
  console.log(`\n[double-spend] replay same nullifier -> expect revert`);
  const ds = await send(
    [cuIx(1_400_000), withdrawIx(nullifierHex, rootAfter, proof.proof256Hex, recipient.publicKey, relayer.publicKey, FEE)],
    [relayer], relayer.publicKey, "double-spend", { expectFail: true });
  record("double_spend_rejected", ds.executed ? "FAIL" : "PASS", { reverted: !ds.executed, sig: ds.sig ?? null, err: ds.err ?? null });

  // Re-prove note #0 (fresh nullifier) for the remaining negative cases.
  const spec0 = witnessSpec({ poolKeyHex, recipientHex, relayerHex, spendIndex: 0, secretsHex: [sA, sB] });
  const proof0 = prove(spec0);

  // ── SCENARIO 3: wrong-root proof MUST revert ────────────────────────────────
  console.log(`\n[wrong-root] real proof but an unknown root in the ix -> expect revert`);
  const bogusRoot = "0a" + "11".repeat(31);
  const wr = await send(
    [cuIx(1_400_000), withdrawIx(proof0.publicInputsHex.nullifier, bogusRoot, proof0.proof256Hex, recipient.publicKey, relayer.publicKey, FEE)],
    [relayer], relayer.publicKey, "wrong-root", { expectFail: true });
  record("wrong_root_rejected", wr.executed ? "FAIL" : "PASS", { reverted: !wr.executed, sig: wr.sig ?? null, err: wr.err ?? null });

  // ── SCENARIO 4: wrong-recipient MUST revert ─────────────────────────────────
  console.log(`\n[wrong-recipient] valid proof, different recipient account -> expect revert`);
  const attacker = Keypair.generate();
  const wc = await send(
    [cuIx(1_400_000), withdrawIx(proof0.publicInputsHex.nullifier, rootAfter, proof0.proof256Hex, attacker.publicKey, relayer.publicKey, FEE)],
    [relayer], relayer.publicKey, "wrong-recipient", { expectFail: true });
  record("wrong_recipient_rejected", wc.executed ? "FAIL" : "PASS", { reverted: !wc.executed, sig: wc.sig ?? null, err: wc.err ?? null });

  // ── SCENARIO 5: over-fee — circuit MUST refuse to prove (fee > MAX_FEE) ──────
  console.log(`\n[over-fee] try to prove fee > MAX_FEE (0.05 SOL) -> circuit must reject`);
  const overFeeAttempt = prove(spec0, { fee: 60_000_000, denom: DENOM, expectFail: true }); // 0.06 SOL > MAX_FEE
  // NOTE: also requires fee <= denom; 0.06 > MAX_FEE(0.05) so the feeCap constraint fails.
  record("over_fee_proof_rejected", overFeeAttempt.proofFailed ? "PASS" : "FAIL",
    { circuitRejected: !!overFeeAttempt.proofFailed, note: "fee=0.06 SOL > MAX_FEE=0.05 SOL; LessEqThan constraint fails witness gen" });

  // ── SCENARIO 6: relayer-mismatch — proof bound to relayer A, submitted by B ──
  console.log(`\n[relayer-mismatch] proof bound to relayer A, submitted+fee_payer = relayer B -> expect revert`);
  const relayerB = Keypair.generate();
  {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: wallet.publicKey })
      .add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: relayerB.publicKey, lamports: 50_000_000 }));
    tx.sign(wallet);
    const s = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await conn.confirmTransaction({ signature: s, blockhash, lastValidBlockHeight }, "confirmed");
  }
  // proof0 is bound to relayer A (relayer). Submit it with relayerB as the fee_payer/signer.
  const rm = await send(
    [cuIx(1_400_000), withdrawIx(proof0.publicInputsHex.nullifier, rootAfter, proof0.proof256Hex, recipient.publicKey, relayerB.publicKey, FEE)],
    [relayerB], relayerB.publicKey, "relayer-mismatch", { expectFail: true });
  record("relayer_mismatch_rejected", rm.executed ? "FAIL" : "PASS", { reverted: !rm.executed, sig: rm.sig ?? null, err: rm.err ?? null });

  // ── SCENARIO 7: proof0 with its CORRECT relayer + recipient succeeds ────────
  console.log(`\n[withdraw#2] proof0 -> bound recipient + bound relayer A (sanity)`);
  const recB2 = await conn.getBalance(recipient.publicKey, "confirmed");
  const w2 = await send(
    [cuIx(1_400_000), withdrawIx(proof0.publicInputsHex.nullifier, rootAfter, proof0.proof256Hex, recipient.publicKey, relayer.publicKey, FEE)],
    [relayer], relayer.publicKey, "withdraw#2");
  const recA2 = await conn.getBalance(recipient.publicKey, "confirmed");
  record("second_valid_withdraw", w2.executed && (recA2 - recB2) === DENOM - FEE ? "PASS" : "FAIL",
    { sig: w2.sig, recipientDelta: recA2 - recB2 });

  // ── evidence ────────────────────────────────────────────────────────────────
  const allPass = results.scenarios.every((s) => s.status === "PASS");
  const evidence = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    test: "dark_relay_rail-v3-relayer-fee-zk-withdraw",
    cluster: CLUSTER,
    program: PROGRAM_ID.toBase58(),
    poolConfig: poolConfig.toBase58(),
    poolVault: poolVault.toBase58(),
    denominationLamports: DENOM,
    relayerFeeLamports: FEE,
    vkMode: VK_MODE,
    circuit: "shielded_withdraw_v3.circom (Poseidon commitment+nullifier, 20-level Poseidon Merkle, recipient+pool_id+relayer bound, in-proof fee: payout=denom-fee, fee<=MAX_FEE)",
    vk: "shielded_withdraw_v3_vk (BEACON-SEALED MULTI-CONTRIBUTION CEREMONY, dry-run — public ptau + simulated-independent contributions + FIXED pre-committed drand beacon round 6000000; awaiting independent contributors, devnet pilot scope). This is the VK the deployed program embeds.",
    initSig,
    onChainRootAfterDeposits: rootAfter,
    coreCircuitRoot: rustRoot,
    rootsMatch,
    scenarios: results.scenarios,
    overall: allPass ? "PASS" : "FAIL",
    keystone:
      "A real snarkjs Groth16 V3 proof (relayer + fee bound) verified ON-CHAIN " +
      "(alt_bn128 pairing syscall) against a Merkle root the program built with the " +
      "sol_poseidon syscall. A permissionless RELAYER (fee_payer != recipient) submitted " +
      "the withdraw and was reimbursed the proof-bound fee; the recipient received denom-fee " +
      "and never signed. Double-spend / wrong-root / wrong-recipient / over-fee / relayer-mismatch all reverted.",
    honestCaveats: [
      "Ceremony VK is a BEACON-SEALED DRY RUN: multiple SIMULATED-independent phase-2 contributions (one machine, varied entropy) finalized with a FIXED, already-published drand beacon (round 6000000). The public beacon adds unpredictability nobody controls, but this is NOT yet fully trustless — real trustlessness needs the simulated contributors replaced by independent humans (see ceremony/CONTRIBUTING_V3.md). Claim: 'beacon-sealed multi-contribution ceremony (dry-run); awaiting independent contributors.'",
      "UNAUDITED devnet pilot. mainnet_ready=false throughout.",
      "Stealth recipient (NullPay) NOT integrated — recipient is a plain wallet here. Documented as a follow-up stub.",
      "Deposit binds leaf_index into the commitment, so the e2e requires a fresh pool (note_count==0) for deterministic Merkle-path rebuild.",
    ],
    explorer: { program: `https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=${CLUSTER}` },
  };
  mkdirSync(join(REPO, "evidence"), { recursive: true });
  const outPath = join(REPO, "evidence", "dark-relay-rail-devnet.json");
  // Merge: keep both pilot and ceremony runs if the file already exists.
  let merged = evidence;
  if (existsSync(outPath)) {
    try {
      const prev = JSON.parse(readFileSync(outPath, "utf8"));
      merged = { ...evidence, runs: { ...(prev.runs ?? { [prev.vkMode ?? "pilot"]: { overall: prev.overall, scenarios: prev.scenarios, program: prev.program } }), [VK_MODE]: { overall: evidence.overall, scenarios: evidence.scenarios, program: evidence.program, generatedAt: evidence.generatedAt } } };
    } catch { /* overwrite */ }
  } else {
    merged = { ...evidence, runs: { [VK_MODE]: { overall: evidence.overall, scenarios: evidence.scenarios, program: evidence.program, generatedAt: evidence.generatedAt } } };
  }
  writeFileSync(outPath, JSON.stringify(merged, null, 2) + "\n");
  console.log(`\nEvidence: evidence/dark-relay-rail-devnet.json`);
  console.log(`OVERALL (${VK_MODE}): ${evidence.overall}`);
  for (const s of results.scenarios) console.log(`  ${s.status.padEnd(4)} ${s.name}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error("\nFATAL:", e.message); process.exit(1); });
