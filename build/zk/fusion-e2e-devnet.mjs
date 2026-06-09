#!/usr/bin/env node
/**
 * PRIVATE-RAIL FUSION — Dark Relay Rail + NullPay, ALL THREE PRIVACY LEGS IN ONE PAYMENT — DEVNET e2e.
 *
 * This is the CAPSTONE demo: a single shielded-pool withdraw whose recipient is a
 * NullPay ONE-TIME ed25519 stealth address resolved from the payee's `.null` name.
 * The result hides all three legs of the payment at once:
 *
 *   (a) SENDER     — hidden by the shielded pool's Groth16 membership proof. The
 *                    withdraw tx carries NO link to which depositor is spending.
 *   (b) AMOUNT     — hidden by the fixed denomination (every note is the same size).
 *   (c) RECIPIENT  — hidden by NullPay: the withdraw pays a one-time stealth address
 *                    P derived from the payee's published meta-address. The payee's
 *                    MAIN wallet never appears in the withdraw tx; P never signs.
 *
 * Flow:
 *   1. PAYEE registers `payee.null` (registrar ix 0x02) + SetStealthMeta (ix 0x06)
 *      publishing meta = spend_pub(32) || view_pub(32).
 *   2. SENDER inits a fresh pool (fixed denom), deposits 2 notes.
 *   3. SENDER resolves `payee.null` on-chain -> reads meta at offset 154 ->
 *      derives a ONE-TIME stealth address P (+ ephemeral R) with NullPay derive().
 *   4. SENDER builds a real V3 Groth16 proof binding recipient=P + relayer + fee,
 *      and publishes R in a memo (StealthAnnounce).
 *   5. A RELAYER (fee_payer != P) submits the shielded withdraw -> P receives
 *      denom-fee, relayer is reimbursed fee, P NEVER signs.
 *   6. PAYEE view-key-scans -> finds P -> recovers one-time scalar p -> sweeps P
 *      to its main wallet with a NATIVE ed25519 signature (raw scalar p; no ZK).
 *   7. ASSERT all three legs + double-spend revert + wrong-recipient revert.
 *
 * Honest scope (see also evidence honestCaveats):
 *   - UNAUDITED devnet pilot. mainnet_ready=false.
 *   - Trusted setup: pilot VK is SINGLE-PARTY (default); --vk-mode ceremony uses the
 *     beacon-sealed multi-contribution DRY-RUN VK (still awaiting independent humans).
 *   - Single-party demo: sender, payee, relayer are all driven by this one script;
 *     the unlinkability is structural (what does / does not appear on-chain), not a
 *     claim that a real anonymity set exists in this 2-note pool.
 *
 * Usage:
 *   node build/zk/fusion-e2e-devnet.mjs <POOL_PROGRAM_ID> --registrar <REGISTRAR_ID> [--vk-mode pilot|ceremony]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes, createHash, webcrypto as crypto } from "node:crypto";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, ComputeBudgetProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import { keygen, derive, scan, recover, signWithStealthScalar } from "../../scripts/nullpay/nullpay-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i !== -1 ? process.argv[i + 1] : d; };
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const CLUSTER = RPC.includes("mainnet") ? "mainnet-beta" : "devnet";
const POOL_PROGRAM = new PublicKey(process.argv[2]);
const REGISTRAR = new PublicKey(arg("registrar"));
const VK_MODE = arg("vk-mode", "pilot");
const DENOM = 100_000_000; // 0.1 SOL fixed denomination
const FEE = 1_000_000;     // 0.001 SOL relayer reimbursement (<= MAX_FEE = 0.05 SOL)

const conn = new Connection(RPC, "confirmed");
const keyPath = execFileSync("solana", ["config", "get"], { encoding: "utf8" })
  .match(/Keypair Path:\s+(.+)/)[1].trim();
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));

// ── pool PDAs (fresh authority => fresh pool, note_count starts at 0) ──────────
const authority = Keypair.generate();
const SEEDS = {
  config: Buffer.from("pool_config"), vault: Buffer.from("pool_vault"),
  leaf: Buffer.from("note_leaf"), nullifier: Buffer.from("nullifier"),
};
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const [poolConfig] = PublicKey.findProgramAddressSync([SEEDS.config, authority.publicKey.toBuffer()], POOL_PROGRAM);
const [poolVault] = PublicKey.findProgramAddressSync([SEEDS.vault, poolConfig.toBuffer()], POOL_PROGRAM);
const noteLeafPda = (i) => PublicKey.findProgramAddressSync([SEEDS.leaf, poolConfig.toBuffer(), u64le(i)], POOL_PROGRAM)[0];
const nullifierPda = (n) => PublicKey.findProgramAddressSync([SEEDS.nullifier, poolConfig.toBuffer(), Buffer.from(n, "hex")], POOL_PROGRAM)[0];

// ── registrar PDAs ────────────────────────────────────────────────────────────
const DOMAIN_SEED = Buffer.from("null-domain");
const REGISTRY_SEED = Buffer.from("null-registry");
const IX_INIT_REGISTRY = 0x01, IX_REGISTER = 0x02, IX_SET_STEALTH_META = 0x06;
const ND_OFF_STEALTH_META = 154;
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const SYS = SystemProgram.programId;
const sysAccount = { pubkey: SYS, isSigner: false, isWritable: false };
const cuIx = (units) => ComputeBudgetProgram.setComputeUnitLimit({ units });
const pad64 = (name) => { const b = Buffer.alloc(64); Buffer.from(name, "utf8").copy(b); return b; };

/** Send a tx and read its ACTUAL on-chain result (meta.err). */
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
    if (expectFail) { console.log(`  [${label}] reverted (not landed): ${e.message?.slice(0, 90)}`); return { executed: false, sig: e.signature ?? null, err: e.message }; }
    console.error(`  [${label}] send FAILED: ${e.message?.slice(0, 200)}`); throw e;
  }
  let meta = null;
  for (let attempt = 0; attempt < 8 && !meta; attempt++) {
    const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (t?.meta) meta = t.meta; else await new Promise((r) => setTimeout(r, 800));
  }
  const err = meta?.err ?? null;
  const executed = err === null;
  const logs = meta?.logMessages ?? [];
  if (executed) { console.log(`  [${label}] ${expectFail ? "UNEXPECTEDLY SUCCEEDED" : "succeeded"} ${sig}`); return { executed: true, sig, logs }; }
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

// ── pool instruction builders ─────────────────────────────────────────────────
const initIx = () => new TransactionInstruction({
  programId: POOL_PROGRAM,
  keys: [
    { pubkey: poolConfig, isSigner: false, isWritable: true },
    { pubkey: poolVault, isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    sysAccount,
  ],
  data: Buffer.concat([Buffer.from([0x00]), u64le(DENOM)]),
});
const depositIx = (leafIndex, commitmentHex) => new TransactionInstruction({
  programId: POOL_PROGRAM,
  keys: [
    { pubkey: poolConfig, isSigner: false, isWritable: true },
    { pubkey: poolVault, isSigner: false, isWritable: true },
    { pubkey: noteLeafPda(leafIndex), isSigner: false, isWritable: true },
    { pubkey: authority.publicKey, isSigner: true, isWritable: true },
    sysAccount,
  ],
  data: Buffer.concat([Buffer.from([0x01]), Buffer.from(commitmentHex, "hex")]),
});
// Withdraw v3: 0x02 | nullifier(32) | root(32) | proof(256) | recipient(32) | relayer(32) | fee(8 LE)
const withdrawIx = (nullifierHex, rootHex, proofHex, recipient, relayer, fee, recipientAccount) =>
  new TransactionInstruction({
    programId: POOL_PROGRAM,
    keys: [
      { pubkey: poolConfig, isSigner: false, isWritable: true },
      { pubkey: poolVault, isSigner: false, isWritable: true },
      { pubkey: nullifierPda(nullifierHex), isSigner: false, isWritable: true },
      { pubkey: recipientAccount ?? recipient, isSigner: false, isWritable: true },
      { pubkey: relayer, isSigner: true, isWritable: true },
      sysAccount,
    ],
    data: Buffer.concat([
      Buffer.from([0x02]), Buffer.from(nullifierHex, "hex"), Buffer.from(rootHex, "hex"),
      Buffer.from(proofHex, "hex"), recipient.toBuffer(), relayer.toBuffer(), u64le(fee),
    ]),
  });

// ── on-chain pool readers ─────────────────────────────────────────────────────
async function readRoot() {
  const ai = await conn.getAccountInfo(poolConfig, "confirmed");
  if (!ai) throw new Error("pool_config not found");
  return Buffer.from(ai.data.slice(44, 76)).toString("hex");
}
async function readNoteCount() {
  const ai = await conn.getAccountInfo(poolConfig, "confirmed");
  return Number(Buffer.from(ai.data.slice(76, 84)).readBigUInt64LE());
}

// ── witness + proof helpers (reuse the rail prover) ───────────────────────────
function genSecretHex() { const b = Buffer.from(crypto.getRandomValues(new Uint8Array(32))); b[0] = 0x05; return b.toString("hex"); }
function witnessSpec(scenario) {
  const tmp = mkdtempSync(join(tmpdir(), "fuse-"));
  const sIn = join(tmp, "scenario.json"), sOut = join(tmp, "spec.json");
  writeFileSync(sIn, JSON.stringify(scenario));
  execFileSync("cargo", ["run", "-q", "-p", "dark-shielded-pool-core", "--bin", "witness_spec",
    "--features", "witness-gen", "--", sIn, sOut], { cwd: REPO, stdio: "pipe" });
  const spec = JSON.parse(readFileSync(sOut, "utf8"));
  rmSync(tmp, { recursive: true, force: true });
  return spec;
}
function prove(spec, { fee = FEE, denom = DENOM } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "fuse-proof-"));
  const sIn = join(tmp, "spec.json"), sOut = join(tmp, "out.json");
  writeFileSync(sIn, JSON.stringify({ ...spec, fee: String(fee), denomination: String(denom) }));
  execFileSync(process.execPath, [join(HERE, "prove-v3.mjs"), sIn, sOut], { stdio: "pipe" });
  const out = JSON.parse(readFileSync(sOut, "utf8"));
  rmSync(tmp, { recursive: true, force: true });
  return out;
}

const ev = {
  schemaVersion: "1.0", generatedAt: new Date().toISOString(),
  test: "private-rail-fusion-all-three-legs-in-one-payment",
  cluster: CLUSTER, poolProgram: POOL_PROGRAM.toBase58(), registrarProgram: REGISTRAR.toBase58(),
  denominationLamports: DENOM, relayerFeeLamports: FEE, vkMode: VK_MODE,
  steps: [], legs: {}, asserts: {}, scenarios: [], honestCaveats: [], overall: "PENDING",
};
const writeEvidence = () => {
  mkdirSync(join(REPO, "evidence"), { recursive: true });
  writeFileSync(join(REPO, "evidence", "private-rail-fusion-devnet.json"), JSON.stringify(ev, null, 2) + "\n");
};
const fail = (m) => { ev.overall = "FAIL"; ev.error = m; writeEvidence(); console.error("\nFAIL:", m); process.exit(1); };
const record = (name, status, detail) => { ev.scenarios.push({ name, status, ...detail }); };

async function main() {
  console.log(`\n=== PRIVATE-RAIL FUSION — all three legs in ONE payment (DEVNET, vk-mode=${VK_MODE}) ===`);
  console.log(`pool program  ${POOL_PROGRAM.toBase58()}`);
  console.log(`registrar     ${REGISTRAR.toBase58()}`);
  console.log(`wallet/sender ${wallet.publicKey.toBase58()}`);
  console.log(`authority     ${authority.publicKey.toBase58()} (fresh pool)`);

  const registrarSend = async (ixs, signers) => {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: wallet.publicKey });
    ixs.forEach((i) => tx.add(i));
    return await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
  };

  // ════════════════════════════════════════════════════════════════════════════
  // PART A — PAYEE side: register payee.null + publish stealth meta-address.
  // ════════════════════════════════════════════════════════════════════════════
  // The PAYEE's identity is a NullPay meta-address (spend_pub || view_pub). The
  // payee's MAIN wallet (sweep destination) is SEPARATE and must never appear in
  // the withdraw tx. Domain owner here = our wallet (it registers + sets meta);
  // that's the *publisher* of the name, distinct from the unlinkable main wallet.
  const payeeSpendSeed = randomBytes(32);
  const payeeKeys = keygen(payeeSpendSeed);
  const payeeMainWallet = Keypair.generate(); // sweep destination — must stay UNLINKED
  console.log(`\n[payee] meta spend_pub ${Buffer.from(payeeKeys.spendPub).toString("hex")}`);
  console.log(`[payee] meta view_pub  ${Buffer.from(payeeKeys.viewPub).toString("hex")}`);
  console.log(`[payee] MAIN wallet    ${payeeMainWallet.publicKey.toBase58()} (must stay UNLINKED)`);

  // Unique name per run so reruns don't collide on an existing domain.
  const NAME = "fusepayee" + Date.now().toString(36).slice(-6);
  const nameSeed = Buffer.from(NAME, "utf8");
  const [configPDA] = PublicKey.findProgramAddressSync([REGISTRY_SEED], REGISTRAR);
  const [domainPDA] = PublicKey.findProgramAddressSync([DOMAIN_SEED, nameSeed], REGISTRAR);
  console.log(`[payee] name           ${NAME}.null`);
  console.log(`[payee] domain PDA     ${domainPDA.toBase58()}`);

  // InitRegistry (idempotent)
  const cfgInfo = await conn.getAccountInfo(configPDA);
  if (!cfgInfo) {
    const data = Buffer.alloc(1 + 8 + 32 + 32);
    data.writeUInt8(IX_INIT_REGISTRY, 0); data.writeBigUInt64LE(0n, 1);
    wallet.publicKey.toBuffer().copy(data, 9); wallet.publicKey.toBuffer().copy(data, 41);
    const ix = new TransactionInstruction({ programId: REGISTRAR, keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPDA, isSigner: false, isWritable: true },
      { pubkey: SYS, isSigner: false, isWritable: false },
    ], data });
    const sig = await registrarSend([ix], [wallet]);
    ev.steps.push({ step: "init_registry", sig }); console.log(`  InitRegistry ${sig}`);
  } else { ev.steps.push({ step: "init_registry", skipped: "already initialised" }); console.log("  Registry already initialised"); }

  // Register payee.null
  {
    const contentHash = createHash("sha256").update(`${NAME}.null:fusion:devnet`).digest();
    const data = Buffer.alloc(1 + 64 + 32);
    data.writeUInt8(IX_REGISTER, 0); pad64(NAME).copy(data, 1); contentHash.copy(data, 65);
    const ix = new TransactionInstruction({ programId: REGISTRAR, keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: domainPDA, isSigner: false, isWritable: true },
      { pubkey: configPDA, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: false, isWritable: false },
      { pubkey: wallet.publicKey, isSigner: false, isWritable: false },
      { pubkey: SYS, isSigner: false, isWritable: false },
    ], data });
    const sig = await registrarSend([ix], [wallet]);
    ev.steps.push({ step: "register", name: `${NAME}.null`, sig, domainPDA: domainPDA.toBase58() });
    console.log(`  Register ${NAME}.null ${sig}`);
  }

  // SetStealthMeta (publish payee meta; reallocs 154->218)
  {
    const data = Buffer.alloc(1 + 64 + 64);
    data.writeUInt8(IX_SET_STEALTH_META, 0); pad64(NAME).copy(data, 1);
    Buffer.from(payeeKeys.meta).copy(data, 65);
    const ix = new TransactionInstruction({ programId: REGISTRAR, keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: domainPDA, isSigner: false, isWritable: true },
      { pubkey: SYS, isSigner: false, isWritable: false },
    ], data });
    const sig = await registrarSend([ix], [wallet]);
    ev.steps.push({ step: "set_stealth_meta", sig }); console.log(`  SetStealthMeta ${sig}`);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PART B — SENDER side: fund the pool, deposit fixed-denom notes.
  // ════════════════════════════════════════════════════════════════════════════
  const relayer = Keypair.generate();
  console.log(`\n[sender] relayer ${relayer.publicKey.toBase58()} (fresh — fronts gas, reimbursed fee)`);
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

  console.log(`\n[pool] InitPool denom=${DENOM} (FIXED denomination => amount hidden)`);
  const initR = await send([initIx()], [authority], authority.publicKey, "init");
  ev.steps.push({ step: "init_pool", sig: initR.sig, denom: DENOM });
  const baseIndex = await readNoteCount();
  if (baseIndex !== 0) fail(`note_count=${baseIndex} != 0 — needs a fresh pool`);

  const poolKeyHex = Buffer.from(poolConfig.toBytes()).toString("hex");
  const relayerHex = Buffer.from(relayer.publicKey.toBytes()).toString("hex");
  const sA = genSecretHex(), sB = genSecretHex();
  // Pre-derive commitments with a placeholder recipient (commitments don't depend on recipient).
  const specForCommits = witnessSpec({ poolKeyHex, recipientHex: "05" + "00".repeat(31), relayerHex, spendIndex: 1, secretsHex: [sA, sB] });
  const commits = specForCommits.commitmentsHex;
  console.log(`\n[pool] deposit 2 notes (anonymity set members; both same denom)`);
  const dep0 = await send([cuIx(400_000), depositIx(0, commits[0])], [authority], authority.publicKey, "deposit#0");
  const dep1 = await send([cuIx(400_000), depositIx(1, commits[1])], [authority], authority.publicKey, "deposit#1");
  ev.steps.push({ step: "deposits", sigs: [dep0.sig, dep1.sig] });
  const rootAfter = await readRoot();
  console.log(`  on-chain root after 2 deposits: ${rootAfter}`);

  // ════════════════════════════════════════════════════════════════════════════
  // PART C — FUSION: resolve payee.null -> derive one-time stealth P -> bind in proof.
  // ════════════════════════════════════════════════════════════════════════════
  console.log(`\n[resolve] read on-chain stealth meta for ${NAME}.null`);
  const domInfo = await conn.getAccountInfo(domainPDA, "confirmed");
  if (!domInfo || domInfo.data.length < ND_OFF_STEALTH_META + 64) fail(`domain not v2-sized (len=${domInfo?.data.length})`);
  const onchainMeta = Uint8Array.from(domInfo.data.subarray(ND_OFF_STEALTH_META, ND_OFF_STEALTH_META + 64));
  if (Buffer.compare(Buffer.from(onchainMeta), Buffer.from(payeeKeys.meta)) !== 0) fail("on-chain meta != published meta");
  ev.asserts.metaRoundtrip = "PASS";
  console.log(`  on-chain meta matches published payee meta: PASS`);

  // Sender derives a ONE-TIME stealth address P + ephemeral R using ONLY the public meta.
  const ephemSeed = randomBytes(32);
  const payment = derive(onchainMeta, ephemSeed);
  const P = new PublicKey(payment.stealthPub);           // the one-time recipient address
  const ephemHex = Buffer.from(payment.ephemPub).toString("hex");
  const recipientHex = Buffer.from(payment.stealthPub).toString("hex"); // 32-byte P as the proof recipient
  console.log(`  stealth address P: ${P.toBase58()}`);
  console.log(`  ephemeral R     : ${ephemHex}`);
  ev.stealth = { address: P.toBase58(), addressHex: recipientHex, ephemR: ephemHex };

  // Build the REAL V3 proof binding recipient = P.
  console.log(`\n[prove] bind recipient=P (the NullPay one-time stealth address), relayer, fee=${FEE}`);
  const spec = witnessSpec({ poolKeyHex, recipientHex, relayerHex, spendIndex: 1, secretsHex: [sA, sB] });
  const rustRoot = spec.expected.rootHex;
  if (rustRoot !== rootAfter) { record("root_consistency", "FAIL", { rustRoot, chainRoot: rootAfter }); fail("root mismatch"); }
  record("root_consistency", "PASS", { root: rustRoot });
  const proof = prove(spec);
  console.log(`  snarkjs local verify: ${proof.localVerify}; zkey=${proof.zkey} vk=${proof.vk}`);
  const nullifierHex = proof.publicInputsHex.nullifier;
  // sanity: the proof's bound recipient field == reduce(P).
  if (proof.publicInputsHex.recipient !== spec.expected.recipientFieldHex) fail("proof recipient field != reduce(P)");
  console.log(`  proof binds recipient field = reduce(P): PASS`);

  // Publish R in a memo (StealthAnnounce) — payee scans this to find P.
  const announce = `nullpay:v1:${NAME}.null:R=${ephemHex}`;

  const pBefore = await conn.getBalance(P, "confirmed");
  const relBefore = await conn.getBalance(relayer.publicKey, "confirmed");

  // ════════════════════════════════════════════════════════════════════════════
  // PART D — RELAYER submits the shielded withdraw to P (P never signs).
  // ════════════════════════════════════════════════════════════════════════════
  console.log(`\n[withdraw] RELAYER submits (fee_payer != P); P receives denom-fee; P never signs`);
  const memoIx = new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(announce, "utf8") });
  const w = await send(
    [cuIx(1_400_000), withdrawIx(nullifierHex, rootAfter, proof.proof256Hex, P, relayer.publicKey, FEE), memoIx],
    [relayer], relayer.publicKey, "fused-withdraw");
  ev.steps.push({ step: "fused_withdraw", sig: w.sig, relayer: relayer.publicKey.toBase58(), recipientP: P.toBase58(), announceR: ephemHex });
  const pAfter = await conn.getBalance(P, "confirmed");
  const relAfter = await conn.getBalance(relayer.publicKey, "confirmed");
  const pDelta = pAfter - pBefore;
  const relDelta = relAfter - relBefore;
  console.log(`  P delta       = ${pDelta} (expect denom - fee = ${DENOM - FEE})`);
  console.log(`  relayer delta = ${relDelta} (expect ~ +fee - txfee - nullifier_rent)`);
  const recipientGotSplit = pDelta === DENOM - FEE;
  const relayerReimbursed = relDelta > -(FEE);
  if (!(w.executed && recipientGotSplit && relayerReimbursed)) {
    record("fused_relayer_withdraw", "FAIL", { sig: w.sig, pDelta, relDelta });
    fail(`fused withdraw split wrong (executed=${w.executed} pDelta=${pDelta} relDelta=${relDelta})`);
  }
  record("fused_relayer_withdraw", "PASS", {
    sig: w.sig, recipientP: P.toBase58(), relayer: relayer.publicKey.toBase58(),
    recipientDelta: pDelta, relayerDelta: relDelta, fee: FEE, payout: DENOM - FEE,
    recipientSigned: false, nullifier: nullifierHex,
  });

  // ════════════════════════════════════════════════════════════════════════════
  // PART E — PAYEE: scan with view key, recover p, sweep P natively (no ZK).
  // ════════════════════════════════════════════════════════════════════════════
  console.log(`\n[payee] view-key scan of announce R -> find P -> recover scalar p -> native sweep`);
  // Payee reconstructs the payment header from the announced R (would parse the memo on-chain).
  const scanPayment = { stealthPub: payment.stealthPub, ephemPub: Buffer.from(ephemHex, "hex") };
  if (!scan(payeeKeys, scanPayment)) fail("payee view-key scan FAILED to detect the payment");
  ev.asserts.scanDetected = "PASS";
  console.log(`  view-key scan detected P: PASS`);
  const rec = recover(payeeKeys, scanPayment); // asserts p*B == P internally
  ev.asserts.scalarRecovered = "PASS";
  console.log(`  recovered one-time scalar p (p*B==P): PASS`);

  // Sweep P -> payee MAIN wallet, signed NATIVELY with raw scalar p.
  const SWEEP_FEE = 5000;
  const balP = await conn.getBalance(P, "confirmed");
  const sweepLamports = balP - SWEEP_FEE;
  const sweepIx = SystemProgram.transfer({ fromPubkey: P, toPubkey: payeeMainWallet.publicKey, lamports: sweepLamports });
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const sweepTx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: P }).add(sweepIx);
  const msgBytes = sweepTx.serializeMessage();
  const sweepSigBytes = signWithStealthScalar(rec.p, payment.stealthPub, msgBytes);
  if (!nacl.sign.detached.verify(msgBytes, sweepSigBytes, payment.stealthPub)) fail("local ed25519 verify of sweep sig under P failed");
  ev.asserts.nativeSigVerifies = "PASS";
  sweepTx.addSignature(P, Buffer.from(sweepSigBytes));
  const sweepSig = await conn.sendRawTransaction(sweepTx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction({ signature: sweepSig, blockhash, lastValidBlockHeight }, "confirmed");
  ev.steps.push({ step: "sweep", sig: sweepSig, from: P.toBase58(), to: payeeMainWallet.publicKey.toBase58(), lamports: sweepLamports });
  console.log(`  native-p sweep -> payee main wallet: ${sweepSig}`);
  const balDest = await conn.getBalance(payeeMainWallet.publicKey, "confirmed");
  if (balDest < sweepLamports) fail(`sweep did not land (bal=${balDest})`);
  ev.asserts.sweepLanded = "PASS";
  console.log(`  payee main wallet balance: ${balDest} — sweep landed: PASS`);

  // ════════════════════════════════════════════════════════════════════════════
  // PART F — THREE-LEG UNLINKABILITY ASSERTIONS (on the WITHDRAW tx).
  // ════════════════════════════════════════════════════════════════════════════
  console.log(`\n[assert] all three legs on the WITHDRAW tx ${w.sig}`);
  const wTx = await conn.getTransaction(w.sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const wAccounts = (wTx.transaction.message.staticAccountKeys?.map((k) => k.toBase58())
    || wTx.transaction.message.accountKeys.map((k) => k.toBase58()));
  const sweepAccounts = (await conn.getTransaction(sweepSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))
    ?.transaction.message.staticAccountKeys?.map((k) => k.toBase58()) ?? [];

  // (a) SENDER unlinkable: no depositor / authority link in the withdraw tx. The
  //     withdraw tx's signers/accounts are {pool PDAs, P, relayer, memo, sys} — the
  //     depositor (authority) and the sender wallet are ABSENT. Spend authorization
  //     is the membership proof, not a signature from the depositor.
  const authorityB58 = authority.publicKey.toBase58();
  const senderB58 = wallet.publicKey.toBase58();
  const senderLinked = wAccounts.includes(authorityB58) || wAccounts.includes(senderB58);
  const legA = !senderLinked;
  ev.legs.sender_unlinkable = {
    pass: legA,
    why: "the withdraw tx contains no depositor signature/account; spend is authorized by the Groth16 membership proof. depositor(authority) and sender wallet absent from the withdraw tx accounts.",
    depositorAbsent: !wAccounts.includes(authorityB58),
    senderWalletAbsent: !wAccounts.includes(senderB58),
    withdrawTxAccounts: wAccounts,
  };
  record("leg_a_sender_unlinkable", legA ? "PASS" : "FAIL", { depositorAbsent: !wAccounts.includes(authorityB58), senderWalletAbsent: !wAccounts.includes(senderB58) });

  // (b) AMOUNT hidden: the payout is a FIXED denomination minus the public relayer
  //     fee; the withdraw carries no per-payment variable amount. Every note in the
  //     pool is the same DENOM, so the on-chain amount reveals nothing distinguishing.
  const legB = (DENOM === ev.denominationLamports) && (pDelta === DENOM - FEE);
  ev.legs.amount_hidden = {
    pass: legB,
    why: "fixed denomination: every note is exactly DENOM lamports; payout = DENOM - FEE is constant across all withdrawals, so the amount is non-distinguishing.",
    denom: DENOM, fee: FEE, payout: DENOM - FEE,
  };
  record("leg_b_amount_hidden", legB ? "PASS" : "FAIL", { denom: DENOM, fee: FEE, payout: DENOM - FEE });

  // (c) RECIPIENT unlinkable: P is a one-time address; the payee's MAIN wallet is
  //     ABSENT from the withdraw tx, and P != meta spend_pub S.
  const payeeMainB58 = payeeMainWallet.publicKey.toBase58();
  const mainAbsentFromWithdraw = !wAccounts.includes(payeeMainB58);
  const pIsOneTime = recipientHex !== Buffer.from(payeeKeys.spendPub).toString("hex");
  const pInWithdraw = wAccounts.includes(P.toBase58()); // P SHOULD be present (it's the recipient)
  const legC = mainAbsentFromWithdraw && pIsOneTime && pInWithdraw;
  ev.legs.recipient_unlinkable = {
    pass: legC,
    why: "P is a one-time stealth address derived per-payment; the payee's main wallet never appears in the withdraw tx, and P != meta spend_pub. Only the payee (with the view key) can link P back to payee.null.",
    payeeMainAbsentFromWithdraw: mainAbsentFromWithdraw,
    P_isOneTime_neq_spendPub: pIsOneTime,
    P_presentAsRecipient: pInWithdraw,
  };
  record("leg_c_recipient_unlinkable", legC ? "PASS" : "FAIL", { payeeMainAbsentFromWithdraw: mainAbsentFromWithdraw, P_isOneTime: pIsOneTime });

  // Cross-tx: payee main wallet only appears in the SWEEP tx (signed by P), never the withdraw.
  ev.asserts.payeeMainOnlyInSweep = (!wAccounts.includes(payeeMainB58) && sweepAccounts.includes(payeeMainB58)) ? "PASS" : "FAIL";

  // ════════════════════════════════════════════════════════════════════════════
  // PART G — NEGATIVE CASES: double-spend revert + wrong-recipient revert.
  // ════════════════════════════════════════════════════════════════════════════
  console.log(`\n[double-spend] replay same nullifier -> expect revert`);
  const ds = await send(
    [cuIx(1_400_000), withdrawIx(nullifierHex, rootAfter, proof.proof256Hex, P, relayer.publicKey, FEE)],
    [relayer], relayer.publicKey, "double-spend", { expectFail: true });
  record("double_spend_rejected", ds.executed ? "FAIL" : "PASS", { reverted: !ds.executed, sig: ds.sig ?? null });

  // wrong-recipient: re-prove note #0 (fresh nullifier, bound to P), but submit paying a DIFFERENT account.
  console.log(`\n[wrong-recipient] valid proof bound to P, but pay a different account -> expect revert`);
  const spec0 = witnessSpec({ poolKeyHex, recipientHex, relayerHex, spendIndex: 0, secretsHex: [sA, sB] });
  const proof0 = prove(spec0);
  const attacker = Keypair.generate();
  const wc = await send(
    [cuIx(1_400_000), withdrawIx(proof0.publicInputsHex.nullifier, rootAfter, proof0.proof256Hex, attacker.publicKey, relayer.publicKey, FEE)],
    [relayer], relayer.publicKey, "wrong-recipient", { expectFail: true });
  record("wrong_recipient_rejected", wc.executed ? "FAIL" : "PASS", { reverted: !wc.executed, sig: wc.sig ?? null });

  // ════════════════════════════════════════════════════════════════════════════
  // EVIDENCE
  // ════════════════════════════════════════════════════════════════════════════
  const allLegs = legA && legB && legC;
  const allScenarios = ev.scenarios.every((s) => s.status === "PASS");
  const allAsserts = Object.values(ev.asserts).every((v) => v === "PASS");
  ev.overall = (allLegs && allScenarios && allAsserts) ? "PASS" : "FAIL";

  ev.payee = {
    nullName: `${NAME}.null`, domainPDA: domainPDA.toBase58(),
    metaSpendPub: Buffer.from(payeeKeys.spendPub).toString("hex"),
    metaViewPub: Buffer.from(payeeKeys.viewPub).toString("hex"),
    mainWallet: payeeMainB58,
    note: "main wallet is the SWEEP DESTINATION; it is ABSENT from the withdraw tx (recipient-unlinkable).",
  };
  ev.poolConfig = poolConfig.toBase58();
  ev.poolVault = poolVault.toBase58();
  ev.onChainRootAfterDeposits = rootAfter;
  ev.circuit = "shielded_withdraw_v3.circom (Poseidon commitment+nullifier, 20-level Poseidon Merkle, recipient+pool_id+relayer bound, in-proof fee: payout=denom-fee, fee<=MAX_FEE)";
  ev.vk = VK_MODE === "ceremony"
    ? "shielded_withdraw_v3_vk (BEACON-SEALED MULTI-CONTRIBUTION CEREMONY, DRY-RUN — public ptau + simulated-independent contributions + FIXED pre-committed drand beacon; awaiting independent contributors, devnet pilot scope)"
    : "shielded_withdraw_v3_vk (SINGLE-PARTY / DEVNET PILOT / NOT TRUSTLESS)";
  ev.keystone =
    "ONE shielded-pool withdraw hides ALL THREE payment legs at once: (a) SENDER — a real Groth16 " +
    "membership proof (alt_bn128 pairing syscall) authorizes the spend with NO depositor signature/link " +
    "in the withdraw tx; (b) AMOUNT — fixed denomination, payout=denom-fee is constant; (c) RECIPIENT — " +
    "the withdraw pays a NullPay ONE-TIME ed25519 stealth address P resolved from payee.null's on-chain " +
    "meta. A permissionless RELAYER submits it (fee_payer != P); P never signs; the payee view-key-scans, " +
    "recovers the one-time scalar p, and sweeps P natively. The payee's MAIN wallet never appears in the withdraw tx.";
  ev.honestCaveats = [
    VK_MODE === "ceremony"
      ? "Ceremony VK is a BEACON-SEALED DRY RUN (simulated-independent contributions + fixed published drand beacon). NOT yet fully trustless; needs independent human contributors (ceremony/CONTRIBUTING_V3.md)."
      : "SINGLE-PARTY trusted setup — NOT trustless. Use --vk-mode ceremony for the beacon-sealed multi-contribution (dry-run) VK.",
    "UNAUDITED devnet pilot. mainnet_ready=false throughout. Library / demo only.",
    "SINGLE-PARTY demo: sender, payee, and relayer are all driven by this one script. The unlinkability is STRUCTURAL (what does / does not appear on-chain), not a claim of a large real anonymity set — this pool has only 2 notes.",
    "The .null domain is registered by our wallet (the publisher of the name); that publisher key is distinct from the payee's unlinkable MAIN wallet, which never touches the withdraw tx.",
    "NullPay recipient privacy is native ed25519 (no ZK / no setup); the sender/amount privacy is the shielded-pool Groth16 rail. The fusion is at the CLIENT level: the rail's recipient is wired to a NullPay one-time stealth address.",
  ];
  ev.explorer = {
    poolProgram: `https://explorer.solana.com/address/${POOL_PROGRAM.toBase58()}?cluster=${CLUSTER}`,
    registrar: `https://explorer.solana.com/address/${REGISTRAR.toBase58()}?cluster=${CLUSTER}`,
    stealthAddress: `https://explorer.solana.com/address/${P.toBase58()}?cluster=${CLUSTER}`,
    withdrawTx: `https://explorer.solana.com/tx/${w.sig}?cluster=${CLUSTER}`,
    sweepTx: `https://explorer.solana.com/tx/${sweepSig}?cluster=${CLUSTER}`,
  };
  writeEvidence();

  console.log(`\n=== RESULT (vk-mode=${VK_MODE}) ===`);
  console.log(`  LEG (a) SENDER unlinkable    : ${legA ? "PASS" : "FAIL"}`);
  console.log(`  LEG (b) AMOUNT hidden        : ${legB ? "PASS" : "FAIL"}`);
  console.log(`  LEG (c) RECIPIENT unlinkable : ${legC ? "PASS" : "FAIL"}`);
  for (const s of ev.scenarios) console.log(`  ${s.status.padEnd(4)} ${s.name}`);
  console.log(`\nOVERALL: ${ev.overall} — evidence/private-rail-fusion-devnet.json`);
  process.exit(ev.overall === "PASS" ? 0 : 1);
}

main().catch((e) => fail(e.stack || String(e)));
