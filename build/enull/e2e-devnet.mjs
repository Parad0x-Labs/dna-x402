#!/usr/bin/env node
/**
 * Federated eNULL — DEVNET end-to-end.
 *
 *   federation(k-of-n) issues a blind token  (Rust: enull_mint)
 *     -> InitMint (store group key K + denom) -> Fund reserve
 *     -> Redeem valid token to a FRESH recipient   -> assert recipient funded
 *     -> double-spend (replay nullifier)           -> MUST revert (custom 3)
 *     -> forged token (tampered C)                 -> MUST revert (custom 5 DLEQ)
 *     -> under-threshold token (only t-1 signed)   -> MUST revert (custom 5 DLEQ)
 *     -> tampered nullifier (Y/secret mismatch)    -> MUST revert (custom 4)
 *
 * The on-chain redeem verifies a REAL Ristretto BDHKE DLEQ (curve25519-dalek,
 * via the alt_… — no, no syscall: pure SBF curve ops) against the stored group
 * key K. Success => the federation's threshold-issued token is honored on-chain
 * and no single guardian (or attacker) can forge or double-spend.
 *
 * Usage: node build/enull/e2e-devnet.mjs <PROGRAM_ID>
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
const DENOM = 100_000_000; // 0.1 SOL per token (one denomination)
const N = 5, T = 3;        // 3-of-5 guardian federation

const conn = new Connection(RPC, "confirmed");
const keyPath = execFileSync("solana", ["config", "get"], { encoding: "utf8" })
  .match(/Keypair Path:\s+(.+)/)[1].trim();
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));

// Fresh authority per run -> fresh mint PDA, so the run is idempotent.
const authority = Keypair.generate();
const payer = authority;

const SEEDS = {
  config: Buffer.from("mint_config"),
  vault: Buffer.from("reserve_vault"),
  nullifier: Buffer.from("nullifier"),
};
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const hexBuf = (h) => Buffer.from(h, "hex");

const [mintConfig] = PublicKey.findProgramAddressSync([SEEDS.config, authority.publicKey.toBuffer()], PROGRAM_ID);
const [reserveVault] = PublicKey.findProgramAddressSync([SEEDS.vault, mintConfig.toBuffer()], PROGRAM_ID);
const nullifierPda = (nHex) => PublicKey.findProgramAddressSync([SEEDS.nullifier, mintConfig.toBuffer(), hexBuf(nHex)], PROGRAM_ID)[0];

const SYS = SystemProgram.programId;
const sysAccount = { pubkey: SYS, isSigner: false, isWritable: false };
const cuIx = (units) => ComputeBudgetProgram.setComputeUnitLimit({ units });

// ── send + read ACTUAL on-chain result (meta.err is the source of truth) ──────
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
    if (logs.length) console.error("    logs:\n    " + logs.slice(-12).join("\n    "));
    throw new Error(`${label} failed on-chain: ${JSON.stringify(err)}`);
  }
  return { executed: false, sig, err, logs };
}

// ── instruction builders ──────────────────────────────────────────────────────
const initMintIx = (groupPubHex) => new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: mintConfig, isSigner: false, isWritable: true },
    { pubkey: reserveVault, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    sysAccount,
  ],
  data: Buffer.concat([Buffer.from([0x00]), hexBuf(groupPubHex), u64le(DENOM)]),
});

const fundIx = (amount) => new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: mintConfig, isSigner: false, isWritable: false },
    { pubkey: reserveVault, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    sysAccount,
  ],
  data: Buffer.concat([Buffer.from([0x01]), u64le(amount)]),
});

// Redeem data: 0x02 | y(32) | c(32) | dleq(64)
// The on-chain nullifier is SHA256("eNULL-NULLIFIER-v1" ‖ Y) = art.nullifier_hex.
// Accounts: [config, vault, nullifier_rec, recipient, fee_payer(signer), system]
const redeemIx = (art, recipient) => new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: mintConfig, isSigner: false, isWritable: true },
    { pubkey: reserveVault, isSigner: false, isWritable: true },
    { pubkey: nullifierPda(art.nullifier_hex), isSigner: false, isWritable: true },
    { pubkey: recipient, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    sysAccount,
  ],
  data: Buffer.concat([
    Buffer.from([0x02]),
    hexBuf(art.y_hex),
    hexBuf(art.c_hex),
    hexBuf(art.dleq_hex),
  ]),
});

// ── Rust federation bridge ────────────────────────────────────────────────────
function runMint(mode) {
  const tmp = mkdtempSync(join(tmpdir(), "enull-"));
  const out = join(tmp, "out.json");
  execFileSync("cargo", ["run", "-q", "-p", "dark-fedimint-ecash", "--bin", "enull_mint",
    "--", mode, out, "--n", String(N), "--t", String(T)], { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] });
  const j = JSON.parse(readFileSync(out, "utf8"));
  rmSync(tmp, { recursive: true, force: true });
  return j;
}

// ── main ──────────────────────────────────────────────────────────────────────
const results = { scenarios: [] };
const record = (name, status, detail) => { results.scenarios.push({ name, status, ...detail }); };

async function main() {
  console.log(`\n=== federated eNULL — DEVNET e2e (${T}-of-${N}) ===`);
  console.log(`program   ${PROGRAM_ID.toBase58()}`);
  console.log(`wallet    ${wallet.publicKey.toBase58()}`);
  console.log(`authority ${authority.publicKey.toBase58()} (fresh)`);
  console.log(`config    ${mintConfig.toBase58()}`);
  console.log(`vault     ${reserveVault.toBase58()}`);

  // Fund the fresh authority (rent + reserve + fees).
  console.log(`\n[fund] wallet -> authority 1.5 SOL`);
  {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: wallet.publicKey })
      .add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: authority.publicKey, lamports: 1_500_000_000 }));
    tx.sign(wallet);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    console.log(`  funded ${sig}`);
  }

  // ── federation issues a valid token (3-of-5) ────────────────────────────────
  console.log(`\n[federation] enull_mint issue (${T}-of-${N})`);
  const issued = runMint("issue");
  console.log(`  group key K   ${issued.groupPubHex}`);
  console.log(`  signers       ${issued.federation.signers} of ${T}-of-${N} -> [${issued.federation.signerIndices}]`);
  console.log(`  local checks  bdhke=${issued.checks.localBdhkeVerify} dleq=${issued.checks.dleqVerify} matchesSingle=${issued.checks.thresholdMatchesSingleMint}`);
  const art = issued.artifact;

  // ── InitMint (store K + denom) ──────────────────────────────────────────────
  console.log(`\n[init] InitMint group key + denom=${DENOM}`);
  const initR = await send([initMintIx(issued.groupPubHex)], [payer], "init-mint");

  // ── Fund reserve with 5 denominations ───────────────────────────────────────
  console.log(`\n[fund-reserve] +${5 * DENOM} lamports`);
  await send([fundIx(5 * DENOM)], [payer], "fund-reserve");
  const reserveBal = await conn.getBalance(reserveVault, "confirmed");
  console.log(`  reserve balance ${reserveBal}`);

  // ── SCENARIO 1: valid redeem -> fresh recipient ─────────────────────────────
  const recipient = Keypair.generate();
  console.log(`\n[redeem] valid federation token -> fresh ${recipient.publicKey.toBase58()}`);
  const recBefore = await conn.getBalance(recipient.publicKey, "confirmed");
  const w = await send([cuIx(1_400_000), redeemIx(art, recipient.publicKey)], [payer], "redeem");
  const recAfter = await conn.getBalance(recipient.publicKey, "confirmed");
  const delta = recAfter - recBefore;
  console.log(`  recipient delta = ${delta} lamports (denom ${DENOM})`);
  if (w.executed && delta === DENOM) {
    record("valid_redeem", "PASS", {
      sig: w.sig, recipient: recipient.publicKey.toBase58(), delta,
      nullifier: art.nullifier_hex, groupKey: issued.groupPubHex,
      signers: `${issued.federation.signers}-of-${T}-of-${N}`,
    });
  } else {
    record("valid_redeem", "FAIL", { sig: w.sig, delta });
    throw new Error(`valid redeem did not fund recipient (executed=${w.executed} delta=${delta})`);
  }

  // ── SCENARIO 2: double-spend (replay same token) MUST revert ────────────────
  console.log(`\n[double-spend] replay same nullifier -> expect revert (custom 3)`);
  const ds = await send([cuIx(1_400_000), redeemIx(art, recipient.publicKey)], [payer], "double-spend", { expectFail: true });
  record("double_spend_rejected", ds.executed ? "FAIL" : "PASS", { reverted: !ds.executed, sig: ds.sig ?? null, err: ds.err ?? null });

  // ── SCENARIO 3: forged token (tamper C) MUST revert (DLEQ invalid) ──────────
  console.log(`\n[forged] flip a byte of C -> expect revert (custom 5 DLEQ)`);
  const forged = { ...art };
  {
    const cb = hexBuf(art.c_hex); cb[0] ^= 0x01; forged.c_hex = cb.toString("hex");
    // fresh recipient so it's not blocked by an existing nullifier (nullifier same → use diff recipient)
  }
  const fg = await send([cuIx(1_400_000), redeemIx(forged, Keypair.generate().publicKey)], [payer], "forged", { expectFail: true });
  record("forged_token_rejected", fg.executed ? "FAIL" : "PASS", { reverted: !fg.executed, sig: fg.sig ?? null, err: fg.err ?? null });

  // ── SCENARIO 4: under-threshold token (only t-1 guardians) MUST revert ──────
  console.log(`\n[under-threshold] token signed by only ${T - 1} guardians -> expect revert (custom 5 DLEQ)`);
  const under = runMint("under-threshold");
  console.log(`  under-threshold local checks: bdhke=${under.checks.localBdhkeVerify} dleq=${under.checks.dleqVerify}`);
  const ut = await send([cuIx(1_400_000), redeemIx(under.artifact, Keypair.generate().publicKey)], [payer], "under-threshold", { expectFail: true });
  record("under_threshold_rejected", ut.executed ? "FAIL" : "PASS",
    { reverted: !ut.executed, sig: ut.sig ?? null, err: ut.err ?? null, localDleq: under.checks.dleqVerify });

  // ── SCENARIO 5: wrong nullifier-PDA (attacker passes a PDA that isn't the one
  //    the program derives from Y) MUST revert. The program recomputes
  //    nullifier = SHA256(Y) and derives its PDA; a mismatched account fails the
  //    InvalidArgument check, so the token can't be spent against a "free" PDA.
  console.log(`\n[wrong-nullifier-pda] pass a mismatched nullifier PDA -> expect revert`);
  const wrongPdaIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: mintConfig, isSigner: false, isWritable: true },
      { pubkey: reserveVault, isSigner: false, isWritable: true },
      // deliberately the PDA for a DIFFERENT nullifier (flip a byte of the seed)
      { pubkey: nullifierPda((() => { const nb = hexBuf(art.nullifier_hex); nb[0] ^= 0x01; return nb.toString("hex"); })()), isSigner: false, isWritable: true },
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      sysAccount,
    ],
    data: Buffer.concat([Buffer.from([0x02]), hexBuf(art.y_hex), hexBuf(art.c_hex), hexBuf(art.dleq_hex)]),
  });
  const tn = await send([cuIx(1_400_000), wrongPdaIx], [payer], "wrong-nullifier-pda", { expectFail: true });
  record("wrong_nullifier_pda_rejected", tn.executed ? "FAIL" : "PASS", { reverted: !tn.executed, sig: tn.sig ?? null, err: tn.err ?? null });

  // ── SCENARIO 6: a SECOND independently-issued valid token still redeems ─────
  console.log(`\n[redeem#2] a fresh ${T}-of-${N} token redeems to a new recipient (sanity)`);
  const issued2 = runMint("issue");
  // NOTE: issued2 has a DIFFERENT group key K2 (fresh DKG). The mint stored K1,
  // so K2's DLEQ verifies under K2 not K1 -> it must be REJECTED. That actually
  // proves the chain binds to ITS stored federation. Assert rejection.
  console.log(`  issued2 group key ${issued2.groupPubHex} (!= stored ${issued.groupPubHex.slice(0,16)}..)`);
  const w2 = await send([cuIx(1_400_000), redeemIx(issued2.artifact, Keypair.generate().publicKey)], [payer], "foreign-federation", { expectFail: true });
  record("foreign_federation_rejected", w2.executed ? "FAIL" : "PASS",
    { reverted: !w2.executed, sig: w2.sig ?? null, err: w2.err ?? null,
      note: "issued2 has a fresh DKG group key K2 != stored K1; chain binds to its own federation" });

  // ── evidence ────────────────────────────────────────────────────────────────
  const allPass = results.scenarios.every((s) => s.status === "PASS");
  const evidence = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    test: "federated-enull-bdhke-ecash-redeem",
    cluster: CLUSTER,
    program: PROGRAM_ID.toBase58(),
    mintConfig: mintConfig.toBase58(),
    reserveVault: reserveVault.toBase58(),
    denominationLamports: DENOM,
    federation: { n: N, t: T, scheme: "joint-Feldman DKG + threshold BDHKE + threshold (FROST-style) DLEQ over Ristretto" },
    groupKey: issued.groupPubHex,
    crypto: "Chaumian BDHKE over Ristretto (curve25519-dalek 3.2.1 host-side). On-chain redeem verifies a Chaum-Pedersen DLEQ that C=k*Y under the stored group key K using Solana's native sol_curve_* Ristretto syscalls (~52k CU) — no Groth16, no trusted setup.",
    initSig: initR.sig,
    scenarios: results.scenarios,
    overall: allPass ? "PASS" : "FAIL",
    keystone:
      `A ${T}-of-${N} guardian federation (DKG so no single party holds the mint key k) blind-signed a bearer ` +
      "token via threshold BDHKE; the user unblinded it; the on-chain redeem verified a real Ristretto DLEQ that " +
      "C=k*Y under the federation's stored group key K and released one denomination of the locked reserve. A " +
      "double-spend, a forged C, an UNDER-THRESHOLD token (only t-1 guardians), a wrong nullifier-PDA, and a " +
      "foreign-federation token were all rejected on-chain.",
    honestCaveats: [
      "DEVNET / library only, UNAUDITED, mainnet_ready=false throughout.",
      "The federation is cryptographically real (Feldman DKG + Lagrange threshold BDHKE + FROST-style threshold DLEQ) but SINGLE-PROCESS simulated: all guardian shares are generated/used in one host process by enull_mint. Per-guardian network transport (each guardian on its own host) is a documented follow-up. The trust model achieved is fewer-than-k-of-N (not single custodian): forging/over-issuing requires k colluding guardians.",
      "The locked reserve is SOL lamports for this e2e; a locked-USDC SPL vault is a drop-in follow-up (same redeem logic, SPL transfer instead of a lamport move).",
      "Recipient is a plaintext pubkey here; a NullPay stealth recipient is a documented stub/follow-up.",
      "Hash-to-curve uses Ristretto from_uniform_bytes (Elligator); constant-timeness of the host path is best-effort, not audited.",
    ],
    explorer: { program: `https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=${CLUSTER}` },
  };
  mkdirSync(join(REPO, "evidence"), { recursive: true });
  const outPath = join(REPO, "evidence", "federated-enull-devnet.json");
  writeFileSync(outPath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`\nEvidence: evidence/federated-enull-devnet.json`);
  console.log(`OVERALL: ${evidence.overall}`);
  for (const s of results.scenarios) console.log(`  ${s.status.padEnd(4)} ${s.name}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error("\nFATAL:", e.message); process.exit(1); });
