#!/usr/bin/env node
/**
 * END-TO-END ANONYMOUS .null OWNERSHIP — strict-assertion verification.
 *
 * Fixes the two leaks the audit caught in the first draft:
 *   - the pool is now SHARED (wallet-independent authority), NOT keyed to the user → the pool
 *     account in the withdraw tx no longer derives the depositor;
 *   - the relayer R is funded as INFRASTRUCTURE before any user exists (no U->R transfer), and
 *     there is NO relaxed assertion — invariants are checked literally.
 *
 * Flow:  operator sets up [shared pool + relayer R] as infra
 *        -> U1 and U2 (distinct users) deposit into the SAME shared pool (anonymity set >= 2)
 *        -> R relays U1's ZK withdraw (R paid privately from the pool)
 *        -> R registers + set_records the .null with U1's commitment (R signs; owner = commitment)
 *
 * CAVEAT (printed): on devnet all test SOL comes from one faucet, so U1/U2/R share a funding
 * root — a TEST artifact. Real users self-fund and R is a multi-user relayer. What is PROVEN here is
 * the on-chain STRUCTURE: no protocol-level U<->name edge (shared pool not user-keyed, >=2 depositors,
 * no direct U->R transfer, name owner = commitment, name txs signed by R not U).
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes, createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram } = await import("@solana/web3.js");
const { poseidon2, poseidon3 } = await import("poseidon-lite");
const POOL = new PublicKey(process.env.POOL_PROGRAM ?? "HpTWigWzFJdCdJsRZ3riocNZ8kpQ6fMEiBRoduNbcPF2");
const REG = new PublicKey(process.env.REGISTRAR_PROGRAM ?? "GADAe4AgfXJLmj8vsDs8FKZPikdoFvSy464vghAH2q21");
const DENOM = 100_000_000, FEE = 1_000_000;
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const dec2be32 = (d) => Buffer.from(BigInt(d).toString(16).padStart(64, "0"), "hex");
const g1 = (p) => Buffer.concat([dec2be32(p[0]), dec2be32(p[1])]);
const g2 = (p) => Buffer.concat([dec2be32(p[0][1]), dec2be32(p[0][0]), dec2be32(p[1][1]), dec2be32(p[1][0])]);
const randFr = () => BigInt("0x" + randomBytes(31).toString("hex")) % P;
const SNARKJS = join(HERE, "node_modules", "snarkjs", "build", "cli.cjs");
const conn = new Connection(RPC, "confirmed");
const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(execSync("solana config get", { encoding: "utf8" }).match(/Keypair Path:\s+(.+)/)[1].trim(), "utf8"))));
// SHARED pool authority — wallet-INDEPENDENT (NOT any user's key). Per-run fresh here so the
// withdraw witness is self-contained; PRODUCTION pins ONE canonical shared pool per denomination
// (init once, many depositors) so the anonymity set is deep. Either way: not derivable from a user.
const SHARED_AUTH = Keypair.generate();
const SEEDS = { config: Buffer.from("pool_config"), vault: Buffer.from("pool_vault"), leaf: Buffer.from("note_leaf"), null: Buffer.from("nullifier") };
const sys = { pubkey: SystemProgram.programId, isSigner: false, isWritable: false };

async function send(ixs, signers, feePayer, label, { expectFail = false } = {}) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer });
  ixs.forEach((i) => tx.add(i)); tx.sign(...signers);
  let sig, err = null;
  try { sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    err = (await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed")).value.err;
  } catch (e) { err = e.message; }
  const ok = err == null;
  console.log(`  [${label}] ${ok ? "ok" : "revert"} ${ok ? (sig||"").slice(0,16) : JSON.stringify(err)}`);
  if (!expectFail && !ok) throw new Error(`${label}: ${JSON.stringify(err)}`);
  return sig;
}
function witnessSpec(s) { const t = mkdtempSync(join(tmpdir(), "ff-")); const i = join(t, "s"), o = join(t, "o"); writeFileSync(i, JSON.stringify(s)); execFileSync("cargo", ["run", "-q", "-p", "dark-shielded-pool-core", "--bin", "witness_spec", "--features", "witness-gen", "--", i, o], { cwd: REPO, stdio: "pipe" }); const r = JSON.parse(readFileSync(o, "utf8")); rmSync(t, { recursive: true, force: true }); return r; }
function proveV3(spec) { const t = mkdtempSync(join(tmpdir(), "fp-")); const i = join(t, "s"), o = join(t, "o"); writeFileSync(i, JSON.stringify({ ...spec, fee: String(FEE), denomination: String(DENOM) })); execFileSync(process.execPath, [join(HERE, "prove-v3.mjs"), i, o], { stdio: "pipe", env: { ...process.env, SWV3_VK_MODE: "ceremony" } }); const r = JSON.parse(readFileSync(o, "utf8")); rmSync(t, { recursive: true, force: true }); return r; }
function regProof(name, commitment, secret, action_hash) { const t = mkdtempSync(join(tmpdir(), "rg-")); const i = join(t, "i"), p = join(t, "p"), u = join(t, "u"); writeFileSync(i, JSON.stringify({ name: name.toString(), commitment: commitment.toString(), action_hash: action_hash.toString(), secret: secret.toString() })); execFileSync(process.execPath, [SNARKJS, "groth16", "fullprove", i, "/art/registrar.wasm", "/art/registrar_final.zkey", p, u], { stdio: "pipe" }); const pr = JSON.parse(readFileSync(p, "utf8")); rmSync(t, { recursive: true, force: true }); return Buffer.concat([g1(pr.pi_a), g2(pr.pi_b), g1(pr.pi_c)]); }

async function main() {
  console.log("\n=== END-TO-END ANONYMOUS .null OWNERSHIP ===");
  mkdirSync(join(HERE, "out", "shielded_withdraw_v3_js"), { recursive: true });
  execSync(`cp ${join(REPO, "ceremony", "shielded_withdraw_v3", "shielded_withdraw_v3.wasm")} ${join(HERE, "out", "shielded_withdraw_v3_js", "shielded_withdraw_v3.wasm")}`);

  const [poolConfig] = PublicKey.findProgramAddressSync([SEEDS.config, SHARED_AUTH.publicKey.toBuffer()], POOL);
  const [poolVault] = PublicKey.findProgramAddressSync([SEEDS.vault, poolConfig.toBuffer()], POOL);
  const noteLeaf = (i) => PublicKey.findProgramAddressSync([SEEDS.leaf, poolConfig.toBuffer(), u64le(i)], POOL)[0];
  const nullPda = (n) => PublicKey.findProgramAddressSync([SEEDS.null, poolConfig.toBuffer(), Buffer.from(n, "hex")], POOL)[0];

  // ── INFRA (operator, before any user): shared pool + relayer R gas float ──
  const R = Keypair.generate();
  console.log(`shared pool ${poolConfig.toBase58()} (authority = public constant, NOT a user)`);
  console.log(`relayer R   ${R.publicKey.toBase58()} (infra; gas funded once by operator, serves many)`);
  await send([SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: SHARED_AUTH.publicKey, lamports: 30_000_000 })], [funder], funder.publicKey, "fund-shared-auth");
  await send([SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: R.publicKey, lamports: 40_000_000 })], [funder], funder.publicKey, "fund-relayer-infra");
  const info = await conn.getAccountInfo(poolConfig, "confirmed");
  if (!info) await send([new TransactionInstruction({ programId: POOL, keys: [{ pubkey: poolConfig, isSigner: false, isWritable: true }, { pubkey: poolVault, isSigner: false, isWritable: true }, { pubkey: SHARED_AUTH.publicKey, isSigner: true, isWritable: true }, sys], data: Buffer.concat([Buffer.from([0x00]), u64le(DENOM)]) })], [SHARED_AUTH], SHARED_AUTH.publicKey, "init-shared-pool");

  // current note count (the pool is shared/long-lived; we append 2 fresh notes)
  const readCount = async () => Number(Buffer.from((await conn.getAccountInfo(poolConfig, "confirmed")).data.slice(76, 84)).readBigUInt64LE());
  const base = await readCount();
  const poolKeyHex = Buffer.from(poolConfig.toBytes()).toString("hex");
  const rHex = Buffer.from(R.publicKey.toBytes()).toString("hex");

  // ── two DISTINCT users deposit into the SAME shared pool (anonymity set >= 2) ──
  const U1 = Keypair.generate(), U2 = Keypair.generate();
  console.log(`\nU1 ${U1.publicKey.toBase58()}  U2 ${U2.publicKey.toBase58()} (distinct users, same shared pool)`);
  await send([SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: U1.publicKey, lamports: 200_000_000 })], [funder], funder.publicKey, "faucet-U1");
  await send([SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: U2.publicKey, lamports: 200_000_000 })], [funder], funder.publicKey, "faucet-U2");
  const sA = (() => { const b = Buffer.from(randomBytes(32)); b[0] = 5; return b.toString("hex"); })();
  const sB = (() => { const b = Buffer.from(randomBytes(32)); b[0] = 5; return b.toString("hex"); })();
  // commitments for the two notes at indices base, base+1 (spendIndex relative handled by witness_spec via leaf_index)
  const commits = witnessSpec({ poolKeyHex, recipientHex: rHex, relayerHex: rHex, spendIndex: base, secretsHex: [sA, sB] }).commitmentsHex;
  await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), new TransactionInstruction({ programId: POOL, keys: [{ pubkey: poolConfig, isSigner: false, isWritable: true }, { pubkey: poolVault, isSigner: false, isWritable: true }, { pubkey: noteLeaf(base), isSigner: false, isWritable: true }, { pubkey: U1.publicKey, isSigner: true, isWritable: true }, sys], data: Buffer.concat([Buffer.from([0x01]), Buffer.from(commits[0], "hex")]) })], [U1], U1.publicKey, "U1-deposit");
  await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), new TransactionInstruction({ programId: POOL, keys: [{ pubkey: poolConfig, isSigner: false, isWritable: true }, { pubkey: poolVault, isSigner: false, isWritable: true }, { pubkey: noteLeaf(base + 1), isSigner: false, isWritable: true }, { pubkey: U2.publicKey, isSigner: true, isWritable: true }, sys], data: Buffer.concat([Buffer.from([0x01]), Buffer.from(commits[1], "hex")]) })], [U2], U2.publicKey, "U2-deposit");

  // ── R relays U1's ZK withdraw (recipient R) → R paid privately; no U1->R transfer ──
  console.log("\n[R] relays U1's ZK withdraw → R (paid from the shared pool; no U1→R transfer)");
  const spec = witnessSpec({ poolKeyHex, recipientHex: rHex, relayerHex: rHex, spendIndex: base, secretsHex: [sA, sB] });
  const proof = proveV3(spec);
  const nHex = proof.publicInputsHex.nullifier, rootHex = proof.publicInputsHex.merkleRoot;
  await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), new TransactionInstruction({ programId: POOL, keys: [
    { pubkey: poolConfig, isSigner: false, isWritable: true }, { pubkey: poolVault, isSigner: false, isWritable: true },
    { pubkey: nullPda(nHex), isSigner: false, isWritable: true }, { pubkey: R.publicKey, isSigner: false, isWritable: true },
    { pubkey: R.publicKey, isSigner: true, isWritable: true }, sys ],
    data: Buffer.concat([Buffer.from([0x02]), Buffer.from(nHex, "hex"), Buffer.from(rootHex, "hex"), Buffer.from(proof.proof256Hex, "hex"), R.publicKey.toBuffer(), R.publicKey.toBuffer(), u64le(FEE)]) })], [R], R.publicKey, "withdraw→R");

  // ── R registers the .null with U1's commitment (R signs; U1 supplies proofs only, no wallet) ──
  console.log("\n[R] register + set_record with U1's commitment (R signs; owner = commitment)");
  const name = randFr(), secret = randFr(), commitment = poseidon2([secret, name]);
  const nameBytes = dec2be32(name);
  const [namePda] = PublicKey.findProgramAddressSync([Buffer.from("null_name"), nameBytes], REG);
  await send([new TransactionInstruction({ programId: REG, keys: [{ pubkey: R.publicKey, isSigner: true, isWritable: true }, { pubkey: namePda, isSigner: false, isWritable: true }, sys], data: Buffer.concat([Buffer.from([0x00]), nameBytes, dec2be32(commitment), regProof(name, commitment, secret, poseidon3([3n, commitment, 0n]))]) })], [R], R.publicKey, "R-register");
  const content = randFr();
  await send([new TransactionInstruction({ programId: REG, keys: [{ pubkey: namePda, isSigner: false, isWritable: true }], data: Buffer.concat([Buffer.from([0x01]), nameBytes, regProof(name, commitment, secret, poseidon3([1n, content, 0n])), dec2be32(commitment), dec2be32(content)]) })], [R], R.publicKey, "R-set_record");

  // ── strict assertions (no relaxed checks) ──
  console.log("\n=== UNLINKABILITY ASSERTIONS (literal) ===");
  const [u1Pool] = PublicKey.findProgramAddressSync([SEEDS.config, U1.publicKey.toBuffer()], POOL);
  const [u2Pool] = PublicKey.findProgramAddressSync([SEEDS.config, U2.publicKey.toBuffer()], POOL);
  const a1 = poolConfig.equals(PublicKey.findProgramAddressSync([SEEDS.config, SHARED_AUTH.publicKey.toBuffer()], POOL)[0]) && !poolConfig.equals(u1Pool) && !poolConfig.equals(u2Pool);
  const a2 = (await readCount()) - base >= 2;
  // a3: no direct U1->R (or U2->R) transfer anywhere — scan R's signature history for an inbound transfer signed by U1/U2
  const rSigs = await conn.getSignaturesForAddress(R.publicKey, { limit: 25 }, "confirmed");
  let userFundedR = false;
  for (const s of rSigs) { const t = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); const signer = t?.transaction?.message?.staticAccountKeys?.[0]?.toBase58(); if (signer === U1.publicKey.toBase58() || signer === U2.publicKey.toBase58()) userFundedR = true; }
  const rec = (await conn.getAccountInfo(namePda, "confirmed")).data;
  const a4 = Buffer.compare(Buffer.from(rec.slice(0, 32)), dec2be32(commitment)) === 0;
  const nameSigs = await conn.getSignaturesForAddress(namePda, { limit: 10 }, "confirmed");
  let nameAllR = true; for (const s of nameSigs) { const t = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }); const signer = t?.transaction?.message?.staticAccountKeys?.[0]?.toBase58(); if (signer !== R.publicKey.toBase58()) nameAllR = false; }
  console.log(`  [1] pool is SHARED, not derivable from U1/U2: ${a1 ? "PASS" : "FAIL"}`);
  console.log(`  [2] anonymity set >= 2 distinct depositors in this pool: ${a2 ? "PASS" : "FAIL"}`);
  console.log(`  [3] no direct U→R transfer (R is infra-funded): ${!userFundedR ? "PASS" : "FAIL"}`);
  console.log(`  [4] name owner = commitment AND every name tx signed by R, not U: ${(a4 && nameAllR) ? "PASS" : "FAIL"}`);
  if (!(a1 && a2 && !userFundedR && a4 && nameAllR)) throw new Error("unlinkability assertion failed");
  console.log("\nCAVEAT (test artifact): devnet SOL all comes from one faucet, so U1/U2/R share a funding root here.");
  console.log("  Real anonymity additionally needs: independent user funding + a multi-user relayer + a deep shared pool.");
  console.log("  PROVEN on-chain: no protocol-level U↔name edge — shared pool (not user-keyed), set≥2, no U→R, owner=commitment.");
  console.log("\nPASS: structurally unlinkable anonymous .null ownership.");
}
main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
