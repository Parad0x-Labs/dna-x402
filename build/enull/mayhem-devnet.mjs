#!/usr/bin/env node
/**
 * MAYHEM — adversarial hammering of the DEPLOYED federated-eNULL redeem program.
 * DEVNET ONLY. Spins up its OWN fresh federation+mint+reserve (fresh authority)
 * so it never touches the existing demo config.
 *
 * Usage: node build/enull/mayhem-devnet.mjs <PROGRAM_ID>
 *
 * Classification per scenario:
 *   HELD          = program correctly rejected a bad input (records the custom code)
 *   BROKE         = program ACCEPTED something it should not have (severity + on-chain sig)
 *   INDETERMINATE = tx did not land (network/blockhash) — never a pass nor a bug; retry-worthy
 */
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, ComputeBudgetProgram,
} from "@solana/web3.js";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
if (RPC.includes("mainnet")) { console.error("REFUSING mainnet RPC"); process.exit(2); }
const PROGRAM_ID = new PublicKey(process.argv[2]);
// Tiny denomination to conserve devnet SOL (any nonzero value is valid per the program).
const DENOM = 2_000_000; // 0.002 SOL per token
const N = 5, T = 3;
const MINT_BIN = join(REPO, "target", "debug", "enull_mint.exe");

const conn = new Connection(RPC, "confirmed");

// throttle: public devnet RPC rate-limits hard (429). Serialize RPC + pace it.
const PACE_MS = Number(process.env.PACE_MS ?? 1400);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let _lastRpc = 0;
async function paced(fn, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const since = Date.now() - _lastRpc;
    if (since < PACE_MS) await sleep(PACE_MS - since);
    _lastRpc = Date.now();
    try { return await fn(); }
    catch (e) {
      if (/429|Too Many Requests/i.test(e.message) && i < tries - 1) { await sleep(2000 * (i + 1)); continue; }
      throw e;
    }
  }
}
// Route hot RPC methods through the pacer.
for (const m of ["getLatestBlockhash", "sendRawTransaction", "confirmTransaction", "getTransaction", "getBalance"]) {
  const orig = conn[m].bind(conn);
  conn[m] = (...a) => paced(() => orig(...a));
}

const keyPath = execFileSync("solana", ["config", "get"], { encoding: "utf8" })
  .match(/Keypair Path:\s+(.+)/)[1].trim();
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));

// FRESH authority -> fresh mint PDA. Never touches the demo's config.
const authority = Keypair.generate();
const payer = authority;

const SEEDS = { config: Buffer.from("mint_config"), vault: Buffer.from("reserve_vault"), nullifier: Buffer.from("nullifier") };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const hexBuf = (h) => Buffer.from(h, "hex");

const [mintConfig] = PublicKey.findProgramAddressSync([SEEDS.config, authority.publicKey.toBuffer()], PROGRAM_ID);
const [reserveVault] = PublicKey.findProgramAddressSync([SEEDS.vault, mintConfig.toBuffer()], PROGRAM_ID);
const nullPdaFor = (cfg, nHex) => PublicKey.findProgramAddressSync([SEEDS.nullifier, cfg.toBuffer(), hexBuf(nHex)], PROGRAM_ID)[0];

// on-chain nullifier = SHA256("eNULL-NULLIFIER-v1" || Y)
const nullifierOfY = (yHex) => {
  const h = createHash("sha256");
  h.update(Buffer.from("eNULL-NULLIFIER-v1"));
  h.update(hexBuf(yHex));
  return h.digest("hex");
};

const SYS = SystemProgram.programId;
const sysAccount = { pubkey: SYS, isSigner: false, isWritable: false };
const cuIx = (units) => ComputeBudgetProgram.setComputeUnitLimit({ units });

function customCode(err) {
  if (err && err.InstructionError && err.InstructionError[1] && typeof err.InstructionError[1] === "object" && "Custom" in err.InstructionError[1])
    return err.InstructionError[1].Custom;
  return null;
}
function errStr(err) {
  if (!err) return null;
  if (err.InstructionError) {
    const e = err.InstructionError[1];
    if (typeof e === "object" && "Custom" in e) return `Custom(${e.Custom})`;
    return String(e);
  }
  return JSON.stringify(err);
}

async function fetchMeta(sig) {
  if (!sig) return null;
  for (let a = 0; a < 10; a++) {
    const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (t?.meta) return t.meta;
    await sleep(1000);
  }
  return null;
}

// Authoritative landing: use confirmTransaction's RETURNED err as source of truth
// (resolves with {value:{err}} for ANY landed tx; only rejects on expiry/node error).
// Never mis-reads a transient null getTransaction as "executed".
async function landTx(tx, blockhash, lastValidBlockHeight, signers, label) {
  tx.sign(...signers);
  let sig = null;
  let r;
  try {
    sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    const err = conf?.value?.err ?? null;
    const meta = await fetchMeta(sig);
    r = { landed: true, executed: err === null, err, code: customCode(err), sig, logs: meta?.logMessages ?? [] };
  } catch (e) {
    // confirmTransaction can THROW even when the tx landed-and-reverted on-chain.
    // Recover the authoritative on-chain result via getTransaction before concluding
    // "did not land" — only a truly absent meta means the tx never executed.
    const meta = await fetchMeta(sig).catch(() => null);
    if (meta) {
      const err = meta.err ?? null;
      r = { landed: true, executed: err === null, err, code: customCode(err), sig, logs: meta.logMessages ?? [] };
    } else {
      const msg = e?.message ?? (typeof e === "object" ? JSON.stringify(e) : String(e));
      r = { landed: false, executed: false, err: msg, code: null, sig: sig ?? (e.signature ?? null), logs: [] };
    }
  }
  if (label) console.log(`  [${label}] ${r.landed ? (r.executed ? "EXECUTED" : "reverted") : "DID-NOT-LAND"} err=${r.landed ? errStr(r.err) : String(r.err).slice(0, 70)} sig=${r.sig}`);
  return r;
}

// send paying with an arbitrary keypair (default = our main payer).
// Retries up to `tries` times if the tx DID NOT LAND (blockhash expiry under heavy
// pacing) — a non-landing tx is a transport artifact, NOT a program result, so we
// re-fetch a fresh blockhash and resend. A LANDED tx (success or on-chain revert)
// returns immediately.
async function sendAs(ixs, feePayerKp, label, tries = 4) {
  let r;
  for (let i = 0; i < tries; i++) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: feePayerKp.publicKey });
    for (const ix of ixs) tx.add(ix);
    r = await landTx(tx, blockhash, lastValidBlockHeight, [feePayerKp], i === 0 ? label : `${label}#retry${i}`);
    if (r.landed) return r;
    await sleep(1200);
  }
  return r; // still not landed after retries
}
const send = (ixs, label) => sendAs(ixs, payer, label);

async function airdropFrom(fromKp, toPubkey, lamports, label) {
  const r = await sendAs([SystemProgram.transfer({ fromPubkey: fromKp.publicKey, toPubkey, lamports })], fromKp, label);
  if (!r.executed) throw new Error(`setup fund failed: ${r.landed ? errStr(r.err) : String(r.err).slice(0, 80)}`);
  return r;
}

function runMint(mode) {
  const tmp = mkdtempSync(join(tmpdir(), "enull-"));
  const out = join(tmp, "out.json");
  execFileSync(MINT_BIN, [mode, out, "--n", String(N), "--t", String(T)],
    { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] });
  const j = JSON.parse(readFileSync(out, "utf8"));
  rmSync(tmp, { recursive: true, force: true });
  return j;
}

const initIxFor = (cfg, vault, auth, groupPubHex, denom = DENOM) => new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [ { pubkey: cfg, isSigner: false, isWritable: true }, { pubkey: vault, isSigner: false, isWritable: true }, { pubkey: auth, isSigner: true, isWritable: true }, sysAccount ],
  data: Buffer.concat([Buffer.from([0x00]), hexBuf(groupPubHex), u64le(denom)]),
});
const fundIxFor = (cfg, vault, auth, amount) => new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [ { pubkey: cfg, isSigner: false, isWritable: false }, { pubkey: vault, isSigner: false, isWritable: true }, { pubkey: auth, isSigner: true, isWritable: true }, sysAccount ],
  data: Buffer.concat([Buffer.from([0x01]), u64le(amount)]),
});
// redeem ix bound to an arbitrary (cfg, vault, signer); allows account + data overrides
function redeemIx(cfg, vault, signerPubkey, { yHex, cHex, dleqHex, recipient, nullPda = null, dataOverride = null }) {
  const data = dataOverride ?? Buffer.concat([Buffer.from([0x02]), hexBuf(yHex), hexBuf(cHex), hexBuf(dleqHex)]);
  const np = nullPda ?? nullPdaFor(cfg, nullifierOfY(yHex));
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: cfg, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: np, isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: true },
      { pubkey: signerPubkey, isSigner: true, isWritable: true },
      sysAccount,
    ],
    data,
  });
}

// Stand up a fresh OWN federation+mint+reserve. Returns {auth, cfg, vault, issued}.
async function standUpFederation(fundLamports, reserveDenoms = 3) {
  const auth = Keypair.generate();
  const [cfg] = PublicKey.findProgramAddressSync([SEEDS.config, auth.publicKey.toBuffer()], PROGRAM_ID);
  const [vault] = PublicKey.findProgramAddressSync([SEEDS.vault, cfg.toBuffer()], PROGRAM_ID);
  await airdropFrom(payer, auth.publicKey, fundLamports, "setup-fund-auth");
  const issued = runMint("issue");
  const ri = await sendAs([initIxFor(cfg, vault, auth.publicKey, issued.groupPubHex)], auth, "setup-init");
  if (!ri.executed) throw new Error(`setup init failed: ${ri.landed ? errStr(ri.err) : ri.err}`);
  if (reserveDenoms > 0) {
    const rf = await sendAs([fundIxFor(cfg, vault, auth.publicKey, reserveDenoms * DENOM)], auth, "setup-reserve");
    if (!rf.executed) throw new Error(`setup reserve failed: ${rf.landed ? errStr(rf.err) : rf.err}`);
  }
  return { auth, cfg, vault, issued };
}

// ── findings ──────────────────────────────────────────────────────────────────
const findings = { held: [], broke: [] };
const indeterminate = [];
const HELD = (name, expected) => { findings.held.push({ name, expected }); console.log(`  >> HELD  ${name}`); };
const BROKE = (name, what, severity, evidence) => { findings.broke.push({ name, what, severity, evidence }); console.log(`  >> BROKE [${severity}] ${name}`); };

function classifyReject(name, r, expectedCode, humanExpected) {
  if (!r.landed) {
    indeterminate.push({ name, reason: `did not land (${String(r.err).slice(0, 70)})` });
    console.log(`  >> INDETERMINATE ${name} (did not land) — not counted`);
    return;
  }
  if (r.executed) { BROKE(name, `program ACCEPTED a bad input that should have been rejected (expected ${humanExpected})`, "high", r.sig ?? "no-sig"); return; }
  if (expectedCode != null && r.code != null && r.code !== expectedCode) {
    BROKE(name, `rejected with WRONG error code: got ${errStr(r.err)}, expected Custom(${expectedCode}) [${humanExpected}]`, "low", r.sig ?? "no-sig"); return;
  }
  HELD(name, `${humanExpected} -> rejected (${errStr(r.err)})`);
}

async function main() {
  console.log(`\n=== MAYHEM — federated eNULL redeem (DEVNET) ===`);
  console.log(`program   ${PROGRAM_ID.toBase58()}`);
  console.log(`authority ${authority.publicKey.toBase58()} (FRESH — own federation)`);
  console.log(`config    ${mintConfig.toBase58()}`);
  console.log(`vault     ${reserveVault.toBase58()}`);

  await airdropFrom(wallet, authority.publicKey, 200_000_000, "fund-authority"); // 0.2 SOL bankrolls all sub-feds

  // OUR primary federation (K1) + mint + reserve(5 denom)
  const issued = runMint("issue");
  const art = issued.artifact;
  console.log(`[federation K1] groupKey ${issued.groupPubHex} signers=${issued.federation.signers}`);
  await send([initIxFor(mintConfig, reserveVault, payer.publicKey, issued.groupPubHex)], "init-mint");
  await send([fundIxFor(mintConfig, reserveVault, payer.publicKey, 5 * DENOM)], "fund-reserve");

  // ── BASELINE: valid redeem must succeed ──────────────────────────────────────
  {
    const rec = Keypair.generate();
    const before = await conn.getBalance(rec.publicKey, "confirmed");
    const r = await send([cuIx(400_000), redeemIx(mintConfig, reserveVault, payer.publicKey, { yHex: art.y_hex, cHex: art.c_hex, dleqHex: art.dleq_hex, recipient: rec.publicKey })], "baseline-valid-redeem");
    const after = await conn.getBalance(rec.publicKey, "confirmed");
    if (r.executed && after - before === DENOM) HELD("baseline_valid_redeem", "valid token redeemed; recipient funded one denomination");
    else if (!r.landed) { indeterminate.push({ name: "baseline_valid_redeem", reason: "did not land" }); }
    else BROKE("baseline_valid_redeem", `valid token did NOT redeem (executed=${r.executed} delta=${after - before})`, "medium", r.sig ?? "no-sig");
  }

  // ── ATTACK 1: double-spend / nullifier reuse (replay the SAME valid token) ────
  {
    const r = await send([cuIx(400_000), redeemIx(mintConfig, reserveVault, payer.publicKey, { yHex: art.y_hex, cHex: art.c_hex, dleqHex: art.dleq_hex, recipient: Keypair.generate().publicKey })], "double-spend");
    classifyReject("double_spend_nullifier_reuse", r, 3, "replayed token -> NullifierAlreadySpent(3)");
  }

  // ── A SECOND fresh federation (K2) whose token is UNSEEN, so we can probe DLEQ/forgery cleanly ──
  const fed2 = await standUpFederation(30_000_000, 3);
  const a2 = fed2.issued.artifact;
  const redeem2 = (mut, label) => sendAs([cuIx(400_000), redeemIx(fed2.cfg, fed2.vault, fed2.auth.publicKey, { yHex: a2.y_hex, cHex: a2.c_hex, dleqHex: a2.dleq_hex, recipient: Keypair.generate().publicKey, ...mut })], fed2.auth, label);

  // ── ATTACK 2: forged C (flip a byte of the signature point) ──────────────────
  {
    const cb = hexBuf(a2.c_hex); cb[7] ^= 0x01;
    const r = await redeem2({ cHex: cb.toString("hex") }, "forged-C");
    classifyReject("forged_C_bad_dleq", r, 5, "tampered C -> DleqInvalid(5)");
  }
  // ── ATTACK 3: tampered DLEQ z (second 32 bytes) ──────────────────────────────
  {
    const db = hexBuf(a2.dleq_hex); db[40] ^= 0x01;
    const r = await redeem2({ dleqHex: db.toString("hex") }, "tampered-dleq-z");
    classifyReject("tampered_dleq_z", r, 5, "tampered DLEQ z -> DleqInvalid(5)");
  }
  // ── ATTACK 4: tampered DLEQ challenge e (first 32 bytes) ──────────────────────
  {
    const db = hexBuf(a2.dleq_hex); db[2] ^= 0x01;
    const r = await redeem2({ dleqHex: db.toString("hex") }, "tampered-dleq-e");
    classifyReject("tampered_dleq_e", r, 5, "tampered DLEQ e -> DleqInvalid(5)");
  }
  // ── ATTACK 5: tampered Y (token point) ───────────────────────────────────────
  {
    const yb = hexBuf(a2.y_hex); yb[3] ^= 0x01;
    const nb = nullPdaFor(fed2.cfg, nullifierOfY(yb.toString("hex")));
    const r = await redeem2({ yHex: yb.toString("hex"), nullPda: nb }, "tampered-Y");
    classifyReject("tampered_Y", r, 5, "tampered Y -> DleqInvalid(5)");
  }
  // ── ATTACK 6: all-zero DLEQ ──────────────────────────────────────────────────
  {
    const r = await redeem2({ dleqHex: "00".repeat(64) }, "zero-dleq");
    classifyReject("zero_dleq", r, 5, "all-zero DLEQ -> DleqInvalid(5)");
  }
  // ── ATTACK 7: all-zero C ─────────────────────────────────────────────────────
  {
    const r = await redeem2({ cHex: "00".repeat(32) }, "zero-C");
    classifyReject("zero_C", r, 5, "all-zero C -> DleqInvalid(5)");
  }
  // ── ATTACK 8: non-canonical / garbage Y (0xFF*32 is not a valid Ristretto point) ─
  {
    const yb = "ff".repeat(32);
    const nb = nullPdaFor(fed2.cfg, nullifierOfY(yb));
    const r = await redeem2({ yHex: yb, nullPda: nb }, "garbage-Y");
    classifyReject("garbage_noncanonical_Y", r, 5, "non-canonical Y -> DleqInvalid(5)");
  }
  // ── ATTACK 9: forged token w/ recipient == reserve vault ─────────────────────
  {
    const cb = hexBuf(a2.c_hex); cb[9] ^= 0x01;
    const r = await sendAs([cuIx(400_000), redeemIx(fed2.cfg, fed2.vault, fed2.auth.publicKey, { yHex: a2.y_hex, cHex: cb.toString("hex"), dleqHex: a2.dleq_hex, recipient: fed2.vault })], fed2.auth, "forged-recipient-is-vault");
    classifyReject("forged_recipient_is_vault", r, 5, "forged token w/ recipient=vault -> DleqInvalid(5)");
  }
  // ── ATTACK 10: VALID redeem with recipient == reserve vault (self-pay / accounting) ─
  {
    const before = await conn.getBalance(fed2.vault, "confirmed");
    const r = await sendAs([cuIx(400_000), redeemIx(fed2.cfg, fed2.vault, fed2.auth.publicKey, { yHex: a2.y_hex, cHex: a2.c_hex, dleqHex: a2.dleq_hex, recipient: fed2.vault })], fed2.auth, "valid-recipient-is-vault");
    const after = await conn.getBalance(fed2.vault, "confirmed");
    if (!r.landed) indeterminate.push({ name: "valid_recipient_equals_vault", reason: "did not land" });
    else if (r.executed) BROKE("valid_recipient_equals_vault", `program ALLOWS recipient==reserve_vault — token is BURNED (nullifier spent) while the vault keeps the funds (net vault delta=${after - before}); a careless caller passing the vault as recipient silently destroys the token for no payout. No recipient!=vault guard.`, "low", r.sig ?? "no-sig");
    else if (r.code != null && r.code !== 10) BROKE("valid_recipient_equals_vault", `rejected with WRONG code: got ${errStr(r.err)}, expected Custom(10) RecipientIsReserveVault`, "low", r.sig ?? "no-sig");
    else HELD("valid_recipient_equals_vault", `recipient==vault rejected (${errStr(r.err)}) — token preserved`);
  }

  // ── ATTACK 11: under-threshold token (only t-1 guardians) under its OWN config ─
  {
    const under = runMint("under-threshold");
    const auth3 = Keypair.generate();
    const [cfg3] = PublicKey.findProgramAddressSync([SEEDS.config, auth3.publicKey.toBuffer()], PROGRAM_ID);
    const [vault3] = PublicKey.findProgramAddressSync([SEEDS.vault, cfg3.toBuffer()], PROGRAM_ID);
    await airdropFrom(payer, auth3.publicKey, 30_000_000, "fund-auth3");
    const i3 = await sendAs([initIxFor(cfg3, vault3, auth3.publicKey, under.groupPubHex)], auth3, "init3");
    const f3 = await sendAs([fundIxFor(cfg3, vault3, auth3.publicKey, 3 * DENOM)], auth3, "fund3");
    if (i3.executed && f3.executed) {
      const ua = under.artifact;
      const r = await sendAs([cuIx(400_000), redeemIx(cfg3, vault3, auth3.publicKey, { yHex: ua.y_hex, cHex: ua.c_hex, dleqHex: ua.dleq_hex, recipient: Keypair.generate().publicKey })], auth3, "under-threshold");
      console.log(`     (under-threshold local checks: bdhke=${under.checks.localBdhkeVerify} dleq=${under.checks.dleqVerify})`);
      classifyReject("under_threshold_token", r, 5, "under-threshold (t-1) token -> DleqInvalid(5)");
    } else indeterminate.push({ name: "under_threshold_token", reason: "setup did not land" });
  }

  // ── ATTACK 12: foreign-federation token (different DKG key) vs OUR stored K1 ───
  {
    const foreign = runMint("issue");
    const fa = foreign.artifact;
    const r = await send([cuIx(400_000), redeemIx(mintConfig, reserveVault, payer.publicKey, { yHex: fa.y_hex, cHex: fa.c_hex, dleqHex: fa.dleq_hex, recipient: Keypair.generate().publicKey })], "foreign-federation");
    classifyReject("foreign_federation_token", r, 5, "foreign DKG key token -> DleqInvalid(5)");
  }

  // ── ATTACK 13: malformed / truncated / unknown instruction data ──────────────
  {
    const short = Buffer.concat([Buffer.from([0x02]), hexBuf(art.y_hex), hexBuf(art.c_hex), Buffer.alloc(20)]); // 85 bytes
    const r = await send([cuIx(400_000), redeemIx(mintConfig, reserveVault, payer.publicKey, { yHex: art.y_hex, cHex: art.c_hex, dleqHex: art.dleq_hex, recipient: Keypair.generate().publicKey, dataOverride: short })], "truncated-redeem-data");
    classifyReject("truncated_instruction_data", r, 7, "truncated redeem data -> InvalidInstruction(7)");
  }
  {
    const r = await send([cuIx(400_000), redeemIx(mintConfig, reserveVault, payer.publicKey, { yHex: art.y_hex, cHex: art.c_hex, dleqHex: art.dleq_hex, recipient: Keypair.generate().publicKey, dataOverride: Buffer.alloc(0) })], "empty-data");
    classifyReject("empty_instruction_data", r, 7, "empty data -> InvalidInstruction(7)");
  }
  {
    const r = await send([cuIx(400_000), redeemIx(mintConfig, reserveVault, payer.publicKey, { yHex: art.y_hex, cHex: art.c_hex, dleqHex: art.dleq_hex, recipient: Keypair.generate().publicKey, dataOverride: Buffer.concat([Buffer.from([0x09]), hexBuf(art.y_hex)]) })], "unknown-disc");
    classifyReject("unknown_discriminator", r, 7, "unknown disc 0x09 -> InvalidInstruction(7)");
  }

  // ── Stand up fed X (valid, unseen token) for wrong-config + cross-vault tests ──
  const fedX = await standUpFederation(30_000_000, 3);
  const ax = fedX.issued.artifact;

  // ── ATTACK 14: redeem a K2 token against the WRONG (mismatched) config ────────
  // Submit fed2's K2 token but pass fedX's config (stored = KX). DLEQ under KX must fail.
  {
    const r = await sendAs([cuIx(400_000), redeemIx(fedX.cfg, fedX.vault, fedX.auth.publicKey, { yHex: a2.y_hex, cHex: a2.c_hex, dleqHex: a2.dleq_hex, recipient: Keypair.generate().publicKey })], fedX.auth, "wrong-mint-config");
    classifyReject("redeem_against_wrong_config", r, 5, "token vs mismatched config key -> DleqInvalid(5)");
  }

  // ── ATTACK 15: CROSS-VAULT DRAIN — valid token for fedX.cfg, but pass OUR reserveVault ──
  // The processor never checks reserve_vault == PDA(config). If it debits OUR vault using
  // fedX's valid DLEQ, that is a cross-federation reserve drain.
  {
    const recipient = Keypair.generate().publicKey;
    const beforeVictim = await conn.getBalance(reserveVault, "confirmed"); // OUR (K1) vault = victim
    const ixDrain = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: fedX.cfg, isSigner: false, isWritable: true },        // valid config (DLEQ passes under KX)
        { pubkey: reserveVault, isSigner: false, isWritable: true },    // VICTIM vault (belongs to mintConfig, not fedX.cfg)
        { pubkey: nullPdaFor(fedX.cfg, nullifierOfY(ax.y_hex)), isSigner: false, isWritable: true },
        { pubkey: recipient, isSigner: false, isWritable: true },
        { pubkey: fedX.auth.publicKey, isSigner: true, isWritable: true },
        sysAccount,
      ],
      data: Buffer.concat([Buffer.from([0x02]), hexBuf(ax.y_hex), hexBuf(ax.c_hex), hexBuf(ax.dleq_hex)]),
    });
    const r = await sendAs([cuIx(400_000), ixDrain], fedX.auth, "cross-vault-drain");
    const afterVictim = await conn.getBalance(reserveVault, "confirmed");
    const victimDelta = afterVictim - beforeVictim;
    const recBal = await conn.getBalance(recipient, "confirmed");
    console.log(`     victimVaultDelta=${victimDelta} recipientBal=${recBal}`);
    if (!r.landed) indeterminate.push({ name: "cross_vault_drain", reason: "did not land" });
    else if (r.executed && victimDelta === -DENOM) BROKE("cross_vault_drain", `valid token for fedX.cfg DRAINED a FOREIGN reserve vault (mintConfig's K1 vault) — processor never binds reserve_vault to PDA(config). Victim lost ${DENOM} lamports.`, "critical", r.sig ?? "no-sig");
    else if (r.executed) BROKE("cross_vault_drain", `redeem with mismatched reserve_vault EXECUTED (victimDelta=${victimDelta}) — should reject`, "high", r.sig ?? "no-sig");
    else HELD("cross_vault_drain", `mismatched reserve_vault rejected (${errStr(r.err)})`);
  }

  // ── ATTACK 16: reserve over-draw (fund < 1 denom, redeem valid token) ─────────
  {
    const auth = Keypair.generate();
    const [cfg] = PublicKey.findProgramAddressSync([SEEDS.config, auth.publicKey.toBuffer()], PROGRAM_ID);
    const [vault] = PublicKey.findProgramAddressSync([SEEDS.vault, cfg.toBuffer()], PROGRAM_ID);
    await airdropFrom(payer, auth.publicKey, 20_000_000, "fund-authR");
    const issR = runMint("issue");
    const i = await sendAs([initIxFor(cfg, vault, auth.publicKey, issR.groupPubHex)], auth, "initR");
    const f = await sendAs([fundIxFor(cfg, vault, auth.publicKey, DENOM / 2)], auth, "fundR-half"); // 0.05 < 0.1
    if (i.executed && f.executed) {
      const ar = issR.artifact;
      const r = await sendAs([cuIx(400_000), redeemIx(cfg, vault, auth.publicKey, { yHex: ar.y_hex, cHex: ar.c_hex, dleqHex: ar.dleq_hex, recipient: Keypair.generate().publicKey })], auth, "reserve-overdraw");
      classifyReject("reserve_overdraw", r, 6, "under-funded reserve -> InsufficientReserve(6)");
    } else indeterminate.push({ name: "reserve_overdraw", reason: "setup did not land" });
  }

  // ── ATTACK 17: InitMint zero denomination & zero group key ────────────────────
  {
    const auth = Keypair.generate();
    const [cfg] = PublicKey.findProgramAddressSync([SEEDS.config, auth.publicKey.toBuffer()], PROGRAM_ID);
    const [vault] = PublicKey.findProgramAddressSync([SEEDS.vault, cfg.toBuffer()], PROGRAM_ID);
    await airdropFrom(payer, auth.publicKey, 15_000_000, "fund-authZ");
    {
      const r = await sendAs([initIxFor(cfg, vault, auth.publicKey, "aa".repeat(32), 0)], auth, "init-zero-denom");
      classifyReject("init_zero_denomination", r, 2, "denom=0 -> ZeroDenomination(2)");
    }
    {
      const r = await sendAs([initIxFor(cfg, vault, auth.publicKey, "00".repeat(32), DENOM)], auth, "init-zero-groupkey");
      classifyReject("init_zero_group_key", r, 9, "group_pub=0 -> WrongMintKey(9)");
    }
  }

  // ── ATTACK 18: re-init an already-initialized config (AlreadyInitialized) ─────
  {
    const issDup = runMint("issue");
    const r = await send([initIxFor(mintConfig, reserveVault, payer.publicKey, issDup.groupPubHex)], "reinit-our-config");
    classifyReject("reinit_already_initialized", r, 0, "re-init our config -> AlreadyInitialized(0)");
  }

  // ── SUMMARY ───────────────────────────────────────────────────────────────────
  console.log(`\n=== MAYHEM RESULTS ===`);
  console.log(`HELD  (${findings.held.length}):`);
  for (const h of findings.held) console.log(`  + ${h.name} — ${h.expected}`);
  console.log(`BROKE (${findings.broke.length}):`);
  for (const b of findings.broke) console.log(`  - [${b.severity}] ${b.name} — ${b.what} (sig=${b.evidence})`);
  if (indeterminate.length) {
    console.log(`INDETERMINATE (${indeterminate.length}) — not counted, re-run to resolve:`);
    for (const i of indeterminate) console.log(`  ? ${i.name} — ${i.reason}`);
  }
  console.log(`\nJSON_RESULTS_START`);
  console.log(JSON.stringify({ scenariosRun: findings.held.length + findings.broke.length, held: findings.held, broke: findings.broke, indeterminate }, null, 2));
  console.log(`JSON_RESULTS_END`);
}

main().catch((e) => { console.error("\nFATAL:", e.message, e.stack); process.exit(1); });
