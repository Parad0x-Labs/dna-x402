#!/usr/bin/env node
/**
 * MAYHEM — adversarial hammering of the PRIVATE-RAIL FUSION flow (pool x stealth).
 * DEVNET ONLY. Spins up its OWN fresh pool + fresh payee.null so it never touches
 * the live demo's deployed config. Tests CROSS-RAIL SEAMS, not pool/registrar
 * internals (covered by other lanes).
 *
 * Scenarios:
 *   S1  tamper published ephemeral R -> payee scan must FAIL safely (no false match)
 *   S2  derive a stealth P, but submit withdraw bound to a DIFFERENT P -> reject (ProofInvalid)
 *   S3  replay the fused withdraw (same nullifier) -> reject (NullifierAlreadySpent)
 *   S4  stealth meta that does NOT match the name -> sender derives P' from foreign meta;
 *       real payee scan must NOT match it (payment is not theirs)
 *   S5  payee MAIN wallet never enters the withdraw tx across N runs
 *   S6  one-time addresses never repeat across payments (N derivations, all distinct)
 *   S7  forged R in the withdraw memo while paying the REAL P -> withdraw still lands
 *       (R is off-chain only) but payee scan of the forged R must FAIL -> funds
 *       become unsweepable-by-scan (availability seam, documented)
 *
 * Usage: node build/zk/fusion-mayhem-devnet.mjs <POOL_PROGRAM_ID> --registrar <REGISTRAR_ID>
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes, createHash, webcrypto as crypto } from "node:crypto";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, ComputeBudgetProgram, sendAndConfirmTransaction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import { keygen, derive, scan, recover } from "../../scripts/nullpay/nullpay-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i !== -1 ? process.argv[i + 1] : d; };
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
if (RPC.includes("mainnet")) { console.error("REFUSING to run on mainnet"); process.exit(2); }
const CLUSTER = "devnet";
const POOL_PROGRAM = new PublicKey(process.argv[2]);
const REGISTRAR = new PublicKey(arg("registrar"));
const DENOM = 100_000_000;
const FEE = 1_000_000;

const conn = new Connection(RPC, "confirmed");
const keyPath = execFileSync("solana", ["config", "get"], { encoding: "utf8" })
  .match(/Keypair Path:\s+(.+)/)[1].trim();
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));

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

const DOMAIN_SEED = Buffer.from("null-domain");
const REGISTRY_SEED = Buffer.from("null-registry");
const IX_INIT_REGISTRY = 0x01, IX_REGISTER = 0x02, IX_SET_STEALTH_META = 0x06;
const ND_OFF_STEALTH_META = 154;
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const SYS = SystemProgram.programId;
const sysAccount = { pubkey: SYS, isSigner: false, isWritable: false };
const cuIx = (units) => ComputeBudgetProgram.setComputeUnitLimit({ units });
const pad64 = (name) => { const b = Buffer.alloc(64); Buffer.from(name, "utf8").copy(b); return b; };

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
    if (expectFail) { return { executed: false, sig: e.signature ?? null, err: e.message, logs: [] }; }
    console.error(`  [${label}] send FAILED: ${e.message?.slice(0, 200)}`); throw e;
  }
  let meta = null;
  for (let attempt = 0; attempt < 10 && !meta; attempt++) {
    const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (t?.meta) meta = t.meta; else await new Promise((r) => setTimeout(r, 800));
  }
  const err = meta?.err ?? null;
  const executed = err === null;
  const logs = meta?.logMessages ?? [];
  return { executed, sig, err, logs };
}

function customCode(logs, err) {
  // pull "custom program error: 0xN" or {"Custom":N}
  for (const l of logs ?? []) {
    const m = l.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
    if (m) return parseInt(m[1], 16);
  }
  if (err && typeof err === "object") {
    const ie = err.InstructionError;
    if (Array.isArray(ie) && ie[1] && typeof ie[1] === "object" && "Custom" in ie[1]) return ie[1].Custom;
  }
  return null;
}
function errName(logs, err) {
  const c = customCode(logs, err);
  const names = {
    0: "AlreadyInitialized", 1: "PoolPaused", 2: "ZeroCommitment", 3: "NullifierAlreadySpent",
    4: "ProofInvalid", 5: "ZeroDenomination", 6: "InsufficientFunds", 7: "NotInitialized",
    8: "InvalidInstruction", 9: "ArithmeticOverflow", 10: "StubNotReady", 11: "BelowMinimumDeposit",
    12: "UnknownRoot", 13: "FeeExceedsDenomination",
  };
  if (c !== null) return `Custom(${c})=${names[c] ?? "?"}`;
  if (err && typeof err === "object" && err.InstructionError) {
    const ie = err.InstructionError;
    if (typeof ie[1] === "string") return ie[1]; // e.g. "InvalidArgument", "MissingRequiredSignature"
  }
  return JSON.stringify(err);
}

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

async function readRoot() {
  const ai = await conn.getAccountInfo(poolConfig, "confirmed");
  return Buffer.from(ai.data.slice(44, 76)).toString("hex");
}
async function readNoteCount() {
  const ai = await conn.getAccountInfo(poolConfig, "confirmed");
  return Number(Buffer.from(ai.data.slice(76, 84)).readBigUInt64LE());
}

function genSecretHex() { const b = Buffer.from(crypto.getRandomValues(new Uint8Array(32))); b[0] = 0x05; return b.toString("hex"); }
function witnessSpec(scenario) {
  const tmp = mkdtempSync(join(tmpdir(), "mh-"));
  const sIn = join(tmp, "scenario.json"), sOut = join(tmp, "spec.json");
  writeFileSync(sIn, JSON.stringify(scenario));
  execFileSync("cargo", ["run", "-q", "-p", "dark-shielded-pool-core", "--bin", "witness_spec",
    "--features", "witness-gen", "--", sIn, sOut], { cwd: REPO, stdio: "pipe" });
  const spec = JSON.parse(readFileSync(sOut, "utf8"));
  rmSync(tmp, { recursive: true, force: true });
  return spec;
}
function prove(spec, { fee = FEE, denom = DENOM } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "mh-proof-"));
  const sIn = join(tmp, "spec.json"), sOut = join(tmp, "out.json");
  writeFileSync(sIn, JSON.stringify({ ...spec, fee: String(fee), denomination: String(denom) }));
  // Mayhem lands REAL fused withdraws against the deployed pool (S3 replay, S5/S7),
  // which embeds the CEREMONY VK — so proofs MUST be ceremony (pilot => Custom(4) ProofInvalid).
  execFileSync(process.execPath, [join(HERE, "prove-v3.mjs"), sIn, sOut],
    { stdio: "pipe", env: { ...process.env, SWV3_VK_MODE: "ceremony" } });
  const out = JSON.parse(readFileSync(sOut, "utf8"));
  rmSync(tmp, { recursive: true, force: true });
  return out;
}

const results = { scenarios: [], held: [], broke: [] };
const hold = (name, expected, detail) => { results.held.push({ name, expected, ...detail }); console.log(`  HELD: ${name} — ${expected}`); };
const broke = (name, what, severity, evidence) => { results.broke.push({ name, what, severity, evidence }); console.log(`  *** BROKE [${severity}]: ${name} — ${what} (${evidence})`); };

async function registrarSend(ixs, signers) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: wallet.publicKey });
  ixs.forEach((i) => tx.add(i));
  return await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" });
}

async function registerPayee(prefix) {
  const spendSeed = randomBytes(32);
  const keys = keygen(spendSeed);
  const mainWallet = Keypair.generate();
  const NAME = prefix + Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 1e3);
  const nameSeed = Buffer.from(NAME, "utf8");
  const [configPDA] = PublicKey.findProgramAddressSync([REGISTRY_SEED], REGISTRAR);
  const [domainPDA] = PublicKey.findProgramAddressSync([DOMAIN_SEED, nameSeed], REGISTRAR);

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
    await registrarSend([ix], [wallet]);
  }
  {
    const contentHash = createHash("sha256").update(`${NAME}.null:mayhem`).digest();
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
    await registrarSend([ix], [wallet]);
  }
  {
    const data = Buffer.alloc(1 + 64 + 64);
    data.writeUInt8(IX_SET_STEALTH_META, 0); pad64(NAME).copy(data, 1);
    Buffer.from(keys.meta).copy(data, 65);
    const ix = new TransactionInstruction({ programId: REGISTRAR, keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: domainPDA, isSigner: false, isWritable: true },
      { pubkey: SYS, isSigner: false, isWritable: false },
    ], data });
    await registrarSend([ix], [wallet]);
  }
  return { keys, mainWallet, NAME, domainPDA };
}

async function readMeta(domainPDA) {
  const info = await conn.getAccountInfo(domainPDA, "confirmed");
  if (!info || info.data.length < ND_OFF_STEALTH_META + 64) throw new Error("domain not v2-sized");
  return Uint8Array.from(info.data.subarray(ND_OFF_STEALTH_META, ND_OFF_STEALTH_META + 64));
}

async function main() {
  console.log(`\n=== FUSION MAYHEM (DEVNET) ===`);
  console.log(`pool      ${POOL_PROGRAM.toBase58()}`);
  console.log(`registrar ${REGISTRAR.toBase58()}`);
  console.log(`authority ${authority.publicKey.toBase58()} (fresh pool)`);

  // ---- PART A: register the REAL payee + a FOREIGN payee (for S4) ----
  console.log(`\n[setup] register real payee + foreign payee`);
  const payee = await registerPayee("mhpay");
  const foreign = await registerPayee("mhfgn");
  console.log(`  real payee     ${payee.NAME}.null  domain ${payee.domainPDA.toBase58()}`);
  console.log(`  foreign payee  ${foreign.NAME}.null domain ${foreign.domainPDA.toBase58()}`);

  // ---- PART B: fresh pool + relayer funding + 2 deposits ----
  const relayer = Keypair.generate();
  {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: wallet.publicKey })
      .add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: authority.publicKey, lamports: 1_000_000_000 }))
      .add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: relayer.publicKey, lamports: 300_000_000 }));
    tx.sign(wallet);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  }
  await send([initIx()], [authority], authority.publicKey, "init");
  const base = await readNoteCount();
  if (base !== 0) throw new Error(`fresh pool expected note_count 0, got ${base}`);

  const poolKeyHex = Buffer.from(poolConfig.toBytes()).toString("hex");
  const relayerHex = Buffer.from(relayer.publicKey.toBytes()).toString("hex");
  const sA = genSecretHex(), sB = genSecretHex();
  const specForCommits = witnessSpec({ poolKeyHex, recipientHex: "05" + "00".repeat(31), relayerHex, spendIndex: 1, secretsHex: [sA, sB] });
  const commits = specForCommits.commitmentsHex;
  await send([cuIx(400_000), depositIx(0, commits[0])], [authority], authority.publicKey, "deposit#0");
  await send([cuIx(400_000), depositIx(1, commits[1])], [authority], authority.publicKey, "deposit#1");
  const rootAfter = await readRoot();
  console.log(`  pool root after 2 deposits ${rootAfter}`);

  // ---- resolve real payee meta, derive the legit one-time P (spendIndex 1) ----
  const meta = await readMeta(payee.domainPDA);
  if (Buffer.compare(Buffer.from(meta), Buffer.from(payee.keys.meta)) !== 0) {
    broke("meta_roundtrip", "on-chain meta != published meta", "high", "registrar stored wrong bytes");
  } else hold("S0_meta_roundtrip", "on-chain meta == published payee meta");

  const ephemSeed = randomBytes(32);
  const payment = derive(meta, ephemSeed);
  const P = new PublicKey(payment.stealthPub);
  const ephemHex = Buffer.from(payment.ephemPub).toString("hex");
  const recipientHex = Buffer.from(payment.stealthPub).toString("hex");
  console.log(`  legit P ${P.toBase58()}  R ${ephemHex.slice(0, 16)}…`);

  // build the legit proof bound to P (note #1)
  const spec = witnessSpec({ poolKeyHex, recipientHex, relayerHex, spendIndex: 1, secretsHex: [sA, sB] });
  if (spec.expected.rootHex !== rootAfter) throw new Error("rust root != chain root");
  const proof = prove(spec);
  const nullifierHex = proof.publicInputsHex.nullifier;

  // ════════════════════════════════════════════════════════════════════════
  // S2 — BINDING: submit the (valid, P-bound) proof but pay a DIFFERENT P'.
  // Derive an independent stealth P' from the SAME meta (different ephem).
  // ════════════════════════════════════════════════════════════════════════
  console.log(`\n[S2] valid proof bound to P, but submit paying a DIFFERENT stealth P'`);
  const payment2 = derive(meta, randomBytes(32));
  const Pprime = new PublicKey(payment2.stealthPub);
  // recipient field in ix = P' (so processor's `recipient == recipient_info.key` passes),
  // but the PROOF was generated binding recipient = P. Proof verify must reject.
  const s2 = await send(
    [cuIx(1_400_000), withdrawIx(nullifierHex, rootAfter, proof.proof256Hex, Pprime, relayer.publicKey, FEE, Pprime)],
    [relayer], relayer.publicKey, "S2-wrong-P", { expectFail: true });
  results.scenarios.push("S2_withdraw_bound_to_different_P");
  if (s2.executed) {
    broke("S2_binding_to_P", "withdraw paying a DIFFERENT stealth P' than the proof bound was ACCEPTED", "critical", `sig=${s2.sig}`);
  } else {
    const code = customCode(s2.logs, s2.err);
    if (code === 4) hold("S2_binding_to_P", "rejected ProofInvalid (recipient binding holds)", { sig: s2.sig });
    else { hold("S2_binding_to_P", `rejected (binding holds) but with ${errName(s2.logs, s2.err)} not ProofInvalid`, { sig: s2.sig });
      broke("S2_binding_wrong_code", `rejected but with ${errName(s2.logs, s2.err)} instead of ProofInvalid(4)`, "low", `sig=${s2.sig}`); }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Now land the LEGIT fused withdraw to P (needed for replay + scan tests).
  // ════════════════════════════════════════════════════════════════════════
  console.log(`\n[legit] land the fused withdraw to the real P (relayer submits; P never signs)`);
  const announce = `nullpay:v1:${payee.NAME}.null:R=${ephemHex}`;
  const memoIx = new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(announce, "utf8") });
  const pBefore = await conn.getBalance(P, "confirmed");
  const w = await send(
    [cuIx(1_400_000), withdrawIx(nullifierHex, rootAfter, proof.proof256Hex, P, relayer.publicKey, FEE), memoIx],
    [relayer], relayer.publicKey, "legit-withdraw");
  if (!w.executed) throw new Error(`legit withdraw failed: ${errName(w.logs, w.err)} sig=${w.sig}`);
  const pAfter = await conn.getBalance(P, "confirmed");
  console.log(`  legit withdraw ${w.sig}  P delta=${pAfter - pBefore} (expect ${DENOM - FEE})`);

  // confirm payee main wallet absent in withdraw tx (single-run check; multi-run is S5)
  const wTx = await conn.getTransaction(w.sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const wAccounts = wTx.transaction.message.staticAccountKeys?.map((k) => k.toBase58())
    || wTx.transaction.message.accountKeys.map((k) => k.toBase58());

  // ════════════════════════════════════════════════════════════════════════
  // S3 — REPLAY: resend the exact same fused withdraw (same nullifier).
  // ════════════════════════════════════════════════════════════════════════
  console.log(`\n[S3] replay the fused withdraw (same nullifier) -> expect NullifierAlreadySpent`);
  const s3 = await send(
    [cuIx(1_400_000), withdrawIx(nullifierHex, rootAfter, proof.proof256Hex, P, relayer.publicKey, FEE)],
    [relayer], relayer.publicKey, "S3-replay", { expectFail: true });
  results.scenarios.push("S3_replay_fused_withdraw");
  if (s3.executed) {
    broke("S3_replay", "replayed fused withdraw with same nullifier was ACCEPTED (double-spend)", "critical", `sig=${s3.sig}`);
  } else {
    const code = customCode(s3.logs, s3.err);
    if (code === 3) hold("S3_replay", "rejected NullifierAlreadySpent", { sig: s3.sig });
    else { hold("S3_replay", `rejected but with ${errName(s3.logs, s3.err)} not NullifierAlreadySpent`, { sig: s3.sig });
      broke("S3_replay_wrong_code", `rejected but ${errName(s3.logs, s3.err)} instead of NullifierAlreadySpent(3)`, "low", `sig=${s3.sig}`); }
  }

  // ════════════════════════════════════════════════════════════════════════
  // S1 — TAMPER R: flip bytes in the published ephemeral R. Payee scan must
  //   either fail to find the point (invalid encoding) or NOT match (wrong R).
  //   A tampered R must NEVER cause a false-positive match on the real P.
  // ════════════════════════════════════════════════════════════════════════
  console.log(`\n[S1] tamper the published ephemeral R -> payee scan must fail safely`);
  results.scenarios.push("S1_tamper_ephemeral_R");
  let s1FalseMatch = false, s1Errors = 0, s1Rejected = 0, s1Total = 0;
  for (let t = 0; t < 6; t++) {
    const bad = Buffer.from(payment.ephemPub);
    // flip a random bit
    const idx = Math.floor(Math.random() * 32);
    bad[idx] ^= (1 << (Math.floor(Math.random() * 8)));
    s1Total++;
    let matched = false, threw = false;
    try {
      matched = scan(payee.keys, { stealthPub: payment.stealthPub, ephemPub: Uint8Array.from(bad) });
    } catch (e) { threw = true; s1Errors++; }
    if (matched) { s1FalseMatch = true; }
    else if (!threw) s1Rejected++;
  }
  // also: zeroed R, all-ones R
  for (const bad of [Buffer.alloc(32, 0), Buffer.alloc(32, 0xff)]) {
    s1Total++;
    try {
      if (scan(payee.keys, { stealthPub: payment.stealthPub, ephemPub: Uint8Array.from(bad) })) s1FalseMatch = true;
      else s1Rejected++;
    } catch { s1Errors++; }
  }
  if (s1FalseMatch) {
    broke("S1_tamper_R", "a TAMPERED ephemeral R produced a FALSE-POSITIVE scan match on the real P", "high", `${s1Total} mutations`);
  } else {
    hold("S1_tamper_R", `all ${s1Total} tampered R mutations -> no false match (${s1Rejected} clean reject, ${s1Errors} invalid-point reject)`);
  }

  // ════════════════════════════════════════════════════════════════════════
  // S4 — WRONG META: sender derives P' from the FOREIGN payee's meta. The REAL
  //   payee must NOT scan-match it (the payment is not theirs); and the foreign
  //   payee SHOULD match it (sanity: meta really is foreign's).
  // ════════════════════════════════════════════════════════════════════════
  console.log(`\n[S4] derive payment from FOREIGN meta -> real payee must NOT match`);
  results.scenarios.push("S4_stealth_meta_not_matching_name");
  const foreignMeta = await readMeta(foreign.domainPDA);
  const foreignPayment = derive(foreignMeta, randomBytes(32));
  const realScansForeign = scan(payee.keys, foreignPayment);
  const foreignScansForeign = scan(foreign.keys, foreignPayment);
  if (realScansForeign) {
    broke("S4_meta_crosslink", "REAL payee view-key matched a payment derived from a DIFFERENT name's meta", "high", "cross-identity false match");
  } else if (!foreignScansForeign) {
    broke("S4_meta_sanity", "foreign payee could not scan its own foreign-meta payment", "medium", "scan logic inconsistent");
  } else {
    hold("S4_meta_not_matching", "real payee does NOT match foreign-meta payment; foreign payee does (no cross-identity link)");
  }
  // also: tamper the meta itself (flip a byte) then derive -> real payee must not match
  const tamperedMeta = Buffer.from(meta); tamperedMeta[0] ^= 0x01;
  let tamperDeriveMatched = false, tamperThrew = false;
  try {
    const tp = derive(Uint8Array.from(tamperedMeta), randomBytes(32));
    tamperDeriveMatched = scan(payee.keys, tp);
  } catch { tamperThrew = true; }
  if (tamperDeriveMatched) broke("S4_tampered_meta_match", "payment from a 1-byte-tampered meta still matched the real payee", "high", "spend_pub tamper not isolating");
  else hold("S4_tampered_meta", tamperThrew ? "tampered meta -> invalid point (reject)" : "tampered meta -> no real-payee match");

  // ════════════════════════════════════════════════════════════════════════
  // S6 — ONE-TIME UNIQUENESS: derive N stealth addresses from the SAME meta;
  //   all P and all R must be DISTINCT (no reuse across payments).
  // ════════════════════════════════════════════════════════════════════════
  console.log(`\n[S6] one-time address uniqueness across N derivations`);
  results.scenarios.push("S6_one_time_addresses_never_repeat");
  const N = 64;
  const seenP = new Set(), seenR = new Set();
  let dupP = 0, dupR = 0, scanFail = 0;
  for (let i = 0; i < N; i++) {
    const pm = derive(meta, randomBytes(32));
    const ph = Buffer.from(pm.stealthPub).toString("hex");
    const rh = Buffer.from(pm.ephemPub).toString("hex");
    if (seenP.has(ph)) dupP++; seenP.add(ph);
    if (seenR.has(rh)) dupR++; seenR.add(rh);
    if (!scan(payee.keys, pm)) scanFail++; // every legit derivation must scan-match
  }
  if (dupP > 0 || dupR > 0) {
    broke("S6_address_reuse", `one-time addresses REPEATED across payments (dupP=${dupP} dupR=${dupR})`, "high", `${N} derivations`);
  } else if (scanFail > 0) {
    broke("S6_scan_consistency", `${scanFail}/${N} legit derivations failed to scan-match the payee`, "medium", "derive/scan asymmetry");
  } else {
    hold("S6_one_time_uniqueness", `${N} derivations: all P distinct, all R distinct, all scan-match the payee`);
  }

  // ════════════════════════════════════════════════════════════════════════
  // S5 — MAIN-WALLET ABSENCE across several independent fused payments. For
  //   each run we derive a NEW P, prove note (alternating index), land the
  //   withdraw, and assert the payee MAIN wallet never appears in the tx, the
  //   sender wallet/authority never appear, and P appears exactly as recipient.
  //   (We already spent note #1 above; spend note #0 here for run #1, and for
  //   additional runs we use fresh pools to get more notes.)
  // ════════════════════════════════════════════════════════════════════════
  console.log(`\n[S5] payee MAIN wallet never enters the withdraw tx across runs`);
  results.scenarios.push("S5_main_wallet_never_in_withdraw");
  const runAccts = [];
  // Run on note #0 of THIS pool.
  {
    const pm = derive(meta, randomBytes(32));
    const P0 = new PublicKey(pm.stealthPub);
    const rHex = Buffer.from(pm.stealthPub).toString("hex");
    const spec0 = witnessSpec({ poolKeyHex, recipientHex: rHex, relayerHex, spendIndex: 0, secretsHex: [sA, sB] });
    const proof0 = prove(spec0);
    const ann0 = `nullpay:v1:${payee.NAME}.null:R=${Buffer.from(pm.ephemPub).toString("hex")}`;
    const m0 = new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(ann0, "utf8") });
    const r0 = await send(
      [cuIx(1_400_000), withdrawIx(proof0.publicInputsHex.nullifier, rootAfter, proof0.proof256Hex, P0, relayer.publicKey, FEE), m0],
      [relayer], relayer.publicKey, "S5-run0");
    if (!r0.executed) { broke("S5_run0_failed", `run0 withdraw failed: ${errName(r0.logs, r0.err)}`, "medium", `sig=${r0.sig}`); }
    else {
      const t0 = await conn.getTransaction(r0.sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const a0 = t0.transaction.message.staticAccountKeys?.map((k) => k.toBase58())
        || t0.transaction.message.accountKeys.map((k) => k.toBase58());
      runAccts.push({ sig: r0.sig, accts: a0, P: P0.toBase58() });
    }
  }

  // Two more runs on a SECOND fresh pool (so we have several independent runs).
  // (re-use the same payee identity; new pool => new notes.)
  // Build a fresh pool inline.
  async function freshPoolRun(label) {
    const auth2 = Keypair.generate();
    const [cfg2] = PublicKey.findProgramAddressSync([SEEDS.config, auth2.publicKey.toBuffer()], POOL_PROGRAM);
    const [vault2] = PublicKey.findProgramAddressSync([SEEDS.vault, cfg2.toBuffer()], POOL_PROGRAM);
    const leaf2 = (i) => PublicKey.findProgramAddressSync([SEEDS.leaf, cfg2.toBuffer(), u64le(i)], POOL_PROGRAM)[0];
    const nul2 = (n) => PublicKey.findProgramAddressSync([SEEDS.nullifier, cfg2.toBuffer(), Buffer.from(n, "hex")], POOL_PROGRAM)[0];
    {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: wallet.publicKey })
        .add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: auth2.publicKey, lamports: 600_000_000 }));
      tx.sign(wallet);
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    }
    const init2 = new TransactionInstruction({ programId: POOL_PROGRAM, keys: [
      { pubkey: cfg2, isSigner: false, isWritable: true }, { pubkey: vault2, isSigner: false, isWritable: true },
      { pubkey: auth2.publicKey, isSigner: true, isWritable: true }, sysAccount,
    ], data: Buffer.concat([Buffer.from([0x00]), u64le(DENOM)]) });
    await send([init2], [auth2], auth2.publicKey, `${label}-init`);
    const pk2 = Buffer.from(cfg2.toBytes()).toString("hex");
    const c2A = genSecretHex(), c2B = genSecretHex();
    const sc = witnessSpec({ poolKeyHex: pk2, recipientHex: "05" + "00".repeat(31), relayerHex, spendIndex: 0, secretsHex: [c2A, c2B] });
    for (let i = 0; i < 2; i++) {
      const dep = new TransactionInstruction({ programId: POOL_PROGRAM, keys: [
        { pubkey: cfg2, isSigner: false, isWritable: true }, { pubkey: vault2, isSigner: false, isWritable: true },
        { pubkey: leaf2(i), isSigner: false, isWritable: true }, { pubkey: auth2.publicKey, isSigner: true, isWritable: true }, sysAccount,
      ], data: Buffer.concat([Buffer.from([0x01]), Buffer.from(sc.commitmentsHex[i], "hex")]) });
      await send([cuIx(400_000), dep], [auth2], auth2.publicKey, `${label}-dep${i}`);
    }
    const ai = await conn.getAccountInfo(cfg2, "confirmed");
    const root2 = Buffer.from(ai.data.slice(44, 76)).toString("hex");
    const pm = derive(meta, randomBytes(32));
    const Pn = new PublicKey(pm.stealthPub);
    const sp = witnessSpec({ poolKeyHex: pk2, recipientHex: Buffer.from(pm.stealthPub).toString("hex"), relayerHex, spendIndex: 0, secretsHex: [c2A, c2B] });
    const pr = prove(sp);
    const wIx = new TransactionInstruction({ programId: POOL_PROGRAM, keys: [
      { pubkey: cfg2, isSigner: false, isWritable: true }, { pubkey: vault2, isSigner: false, isWritable: true },
      { pubkey: nul2(pr.publicInputsHex.nullifier), isSigner: false, isWritable: true },
      { pubkey: Pn, isSigner: false, isWritable: true }, { pubkey: relayer.publicKey, isSigner: true, isWritable: true }, sysAccount,
    ], data: Buffer.concat([Buffer.from([0x02]), Buffer.from(pr.publicInputsHex.nullifier, "hex"), Buffer.from(root2, "hex"),
      Buffer.from(pr.proof256Hex, "hex"), Pn.toBuffer(), relayer.publicKey.toBuffer(), u64le(FEE)]) });
    const ann = `nullpay:v1:${payee.NAME}.null:R=${Buffer.from(pm.ephemPub).toString("hex")}`;
    const mIx = new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(ann, "utf8") });
    const r = await send([cuIx(1_400_000), wIx, mIx], [relayer], relayer.publicKey, label);
    if (!r.executed) { broke(`${label}_failed`, `withdraw failed: ${errName(r.logs, r.err)}`, "medium", `sig=${r.sig}`); return; }
    const t = await conn.getTransaction(r.sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const a = t.transaction.message.staticAccountKeys?.map((k) => k.toBase58())
      || t.transaction.message.accountKeys.map((k) => k.toBase58());
    runAccts.push({ sig: r.sig, accts: a, P: Pn.toBase58() });
  }
  await freshPoolRun("S5-run1");
  await freshPoolRun("S5-run2");

  // also include the first legit withdraw
  runAccts.unshift({ sig: w.sig, accts: wAccounts, P: P.toBase58() });

  const payeeMainB58 = payee.mainWallet.publicKey.toBase58();
  const senderB58 = wallet.publicKey.toBase58();
  const authB58 = authority.publicKey.toBase58();
  let mainLeak = 0, senderLeak = 0, pMissing = 0, repeatP = 0;
  const allP = new Set();
  for (const r of runAccts) {
    if (r.accts.includes(payeeMainB58)) mainLeak++;
    if (r.accts.includes(senderB58) || r.accts.includes(authB58)) senderLeak++;
    if (!r.accts.includes(r.P)) pMissing++;
    if (allP.has(r.P)) repeatP++; allP.add(r.P);
  }
  console.log(`  runs=${runAccts.length} mainLeak=${mainLeak} senderLeak=${senderLeak} pMissing=${pMissing} repeatP=${repeatP}`);
  if (mainLeak > 0) {
    broke("S5_main_wallet_leak", `payee MAIN wallet appeared in ${mainLeak}/${runAccts.length} withdraw txs`, "high", runAccts.map((r) => r.sig).join(","));
  } else {
    hold("S5_main_absent", `payee main wallet absent from all ${runAccts.length} withdraw txs; P present as recipient in each; no P reused on-chain`);
  }
  if (senderLeak > 0) broke("S5_sender_leak", `sender/authority appeared in ${senderLeak}/${runAccts.length} withdraw txs`, "high", "sender-unlinkability seam");
  else hold("S5_sender_absent", `sender wallet + depositor authority absent from all ${runAccts.length} withdraw txs`);
  if (pMissing > 0) broke("S5_p_missing", `recipient P missing from ${pMissing} withdraw txs`, "low", "recipient not present");

  // ════════════════════════════════════════════════════════════════════════
  // S7 — FORGED R in memo while paying the REAL P. Withdraw should still land
  //   (R is off-chain only, not consumed on-chain) but a payee scanning the
  //   forged R must NOT find P -> documents the availability seam: R integrity
  //   is the sender's responsibility, not enforced on-chain.
  // ════════════════════════════════════════════════════════════════════════
  console.log(`\n[S7] forged R in the withdraw memo while paying the REAL P (off-chain R seam)`);
  results.scenarios.push("S7_forged_R_in_memo_seam");
  // Use the SECOND fresh pool path quickly: derive a payment, but announce a DIFFERENT R.
  // (Reuse freshPoolRun-like flow but with a mismatched memo.)
  {
    const auth3 = Keypair.generate();
    const [cfg3] = PublicKey.findProgramAddressSync([SEEDS.config, auth3.publicKey.toBuffer()], POOL_PROGRAM);
    const [vault3] = PublicKey.findProgramAddressSync([SEEDS.vault, cfg3.toBuffer()], POOL_PROGRAM);
    const leaf3 = (i) => PublicKey.findProgramAddressSync([SEEDS.leaf, cfg3.toBuffer(), u64le(i)], POOL_PROGRAM)[0];
    const nul3 = (n) => PublicKey.findProgramAddressSync([SEEDS.nullifier, cfg3.toBuffer(), Buffer.from(n, "hex")], POOL_PROGRAM)[0];
    {
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: wallet.publicKey })
        .add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: auth3.publicKey, lamports: 600_000_000 }));
      tx.sign(wallet);
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
      await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    }
    const init3 = new TransactionInstruction({ programId: POOL_PROGRAM, keys: [
      { pubkey: cfg3, isSigner: false, isWritable: true }, { pubkey: vault3, isSigner: false, isWritable: true },
      { pubkey: auth3.publicKey, isSigner: true, isWritable: true }, sysAccount,
    ], data: Buffer.concat([Buffer.from([0x00]), u64le(DENOM)]) });
    await send([init3], [auth3], auth3.publicKey, "S7-init");
    const pk3 = Buffer.from(cfg3.toBytes()).toString("hex");
    const c3A = genSecretHex(), c3B = genSecretHex();
    const sc = witnessSpec({ poolKeyHex: pk3, recipientHex: "05" + "00".repeat(31), relayerHex, spendIndex: 0, secretsHex: [c3A, c3B] });
    for (let i = 0; i < 2; i++) {
      const dep = new TransactionInstruction({ programId: POOL_PROGRAM, keys: [
        { pubkey: cfg3, isSigner: false, isWritable: true }, { pubkey: vault3, isSigner: false, isWritable: true },
        { pubkey: leaf3(i), isSigner: false, isWritable: true }, { pubkey: auth3.publicKey, isSigner: true, isWritable: true }, sysAccount,
      ], data: Buffer.concat([Buffer.from([0x01]), Buffer.from(sc.commitmentsHex[i], "hex")]) });
      await send([cuIx(400_000), dep], [auth3], auth3.publicKey, `S7-dep${i}`);
    }
    const ai = await conn.getAccountInfo(cfg3, "confirmed");
    const root3 = Buffer.from(ai.data.slice(44, 76)).toString("hex");
    const pm = derive(meta, randomBytes(32));
    const Pn = new PublicKey(pm.stealthPub);
    const sp = witnessSpec({ poolKeyHex: pk3, recipientHex: Buffer.from(pm.stealthPub).toString("hex"), relayerHex, spendIndex: 0, secretsHex: [c3A, c3B] });
    const pr = prove(sp);
    // FORGE the announced R: random 32 bytes that are a valid point but NOT pm.ephemPub
    const forgedR = derive(meta, randomBytes(32)).ephemPub;
    const wIx = new TransactionInstruction({ programId: POOL_PROGRAM, keys: [
      { pubkey: cfg3, isSigner: false, isWritable: true }, { pubkey: vault3, isSigner: false, isWritable: true },
      { pubkey: nul3(pr.publicInputsHex.nullifier), isSigner: false, isWritable: true },
      { pubkey: Pn, isSigner: false, isWritable: true }, { pubkey: relayer.publicKey, isSigner: true, isWritable: true }, sysAccount,
    ], data: Buffer.concat([Buffer.from([0x02]), Buffer.from(pr.publicInputsHex.nullifier, "hex"), Buffer.from(root3, "hex"),
      Buffer.from(pr.proof256Hex, "hex"), Pn.toBuffer(), relayer.publicKey.toBuffer(), u64le(FEE)]) });
    const ann = `nullpay:v1:${payee.NAME}.null:R=${Buffer.from(forgedR).toString("hex")}`;
    const mIx = new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(ann, "utf8") });
    const r = await send([cuIx(1_400_000), wIx, mIx], [relayer], relayer.publicKey, "S7-forgedR");
    const landed = r.executed;
    // payee scans the FORGED R -> must NOT match the real P
    const scanForged = scan(payee.keys, { stealthPub: pm.stealthPub, ephemPub: forgedR });
    // payee scans the REAL R (recovered out-of-band) -> matches
    const scanReal = scan(payee.keys, pm);
    if (landed && !scanForged && scanReal) {
      hold("S7_forged_R_seam",
        "forged-R withdraw lands on-chain (R is off-chain, not verified by the program) but the payee scanning the forged R cannot find P; only the real R locates P");
    } else if (scanForged) {
      broke("S7_forged_R_match", "a forged R produced a scan match (R is not binding to the derived P)", "medium", `sig=${r.sig}`);
    } else if (!landed) {
      // not a bug per se, but unexpected for this flow
      hold("S7_forged_R_seam", `withdraw with forged-R memo did not land (${errName(r.logs, r.err)}); on-chain does not depend on R either way`);
    }
  }

  // ---- summary ----
  results.poolConfig = poolConfig.toBase58();
  results.payeeName = `${payee.NAME}.null`;
  console.log(`\n=== MAYHEM SUMMARY ===`);
  console.log(`scenarios run: ${results.scenarios.length}`);
  console.log(`HELD: ${results.held.length}  BROKE: ${results.broke.length}`);
  mkdirSync(join(REPO, "evidence"), { recursive: true });
  writeFileSync(join(REPO, "evidence", "fusion-mayhem-devnet.json"), JSON.stringify(results, null, 2) + "\n");
  console.log("evidence -> evidence/fusion-mayhem-devnet.json");
}

main().catch((e) => { console.error("\nMAYHEM HARNESS ERROR:", e.stack || String(e)); process.exit(1); });
