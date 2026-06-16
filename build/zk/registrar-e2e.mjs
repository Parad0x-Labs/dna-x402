#!/usr/bin/env node
/**
 * dark_registrar e2e — anonymous .null ownership (register → manage → transfer → replay-rejected).
 *
 * Demonstrates: ownership = a commitment (no pubkey); manage/transfer authorized by a ZK proof
 * of knowledge of the secret; the tx FEE-PAYER (a relayer/ephemeral) signs but is NOT an
 * instruction account → unlinkable from the owner. seq + action-binding stop replay.
 *
 * Env: REGISTRAR_PROGRAM, REG_WASM, REG_ZKEY, REG_VK, RPC. Signer via solana shim (= relayer).
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const PROGRAM = process.env.REGISTRAR_PROGRAM;
const WASM = process.env.REG_WASM ?? "/art/registrar.wasm";
const ZKEY = process.env.REG_ZKEY ?? "/art/registrar_final.zkey";
const VK = process.env.REG_VK ?? "/art/registrar_vk.json";
const SNARKJS = join(process.cwd(), "node_modules", "snarkjs", "build", "cli.cjs");

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const DOMAIN_SETRECORD = 1n, DOMAIN_TRANSFER = 2n;
const dec2be32 = (d) => Buffer.from(BigInt(d).toString(16).padStart(64, "0"), "hex");
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const g1 = (p) => Buffer.concat([dec2be32(p[0]), dec2be32(p[1])]);
const g2 = (p) => Buffer.concat([dec2be32(p[0][1]), dec2be32(p[0][0]), dec2be32(p[1][1]), dec2be32(p[1][0])]);
const randFr = () => BigInt("0x" + randomBytes(31).toString("hex")) % P;

const { poseidon2, poseidon3 } = await import("poseidon-lite");
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram }
  = await import("@solana/web3.js");

if (!PROGRAM) { console.error("REGISTRAR_PROGRAM required"); process.exit(1); }
const keyPath = execSync("solana config get", { encoding: "utf8" }).match(/Keypair Path:\s+(.+)/)[1].trim();
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8")))); // = relayer/fee-payer
const conn = new Connection(RPC, "confirmed");
const prog = new PublicKey(PROGRAM);

function ownershipProof({ name, commitment, secret, action_hash }) {
  const tmp = mkdtempSync(join(tmpdir(), "reg-"));
  const inP = join(tmp, "in.json"), pfP = join(tmp, "p.json"), pubP = join(tmp, "pub.json");
  writeFileSync(inP, JSON.stringify({ name: name.toString(), commitment: commitment.toString(), action_hash: action_hash.toString(), secret: secret.toString() }));
  execFileSync(process.execPath, [SNARKJS, "groth16", "fullprove", inP, WASM, ZKEY, pfP, pubP], { stdio: "pipe" });
  execFileSync(process.execPath, [SNARKJS, "groth16", "verify", VK, pubP, pfP], { stdio: "pipe" });
  const proof = JSON.parse(readFileSync(pfP, "utf8"));
  rmSync(tmp, { recursive: true, force: true });
  return Buffer.concat([g1(proof.pi_a), g2(proof.pi_b), g1(proof.pi_c)]); // 256B
}

let sendNonce = 0;
async function send(ix, label, { expectFail = false } = {}) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  // unique CU per call → every tx has a distinct signature, so a replay of identical instruction
  // data is a GENUINE re-execution (not silently deduped to the original's success by the network).
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: payer.publicKey })
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 + (sendNonce++) })).add(ix);
  tx.sign(payer);
  let sig, err = null;
  try { sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    err = (await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed")).value.err;
  } catch (e) { err = e.message; }
  const ok = err == null;
  console.log(`  [${label}] ${ok ? "ok" : "revert"} ${ok ? sig : JSON.stringify(err)}`);
  if (expectFail && ok) throw new Error(`${label}: expected revert, succeeded`);
  if (!expectFail && !ok) throw new Error(`${label}: expected success, reverted ${JSON.stringify(err)}`);
  return sig;
}

const readRec = async (pda) => { const ai = await conn.getAccountInfo(pda, "confirmed"); return ai ? ai.data : null; };

async function main() {
  console.log(`\n=== dark_registrar e2e (program ${PROGRAM}) ===\n relayer/fee-payer ${payer.publicKey.toBase58()} bal ${(await conn.getBalance(payer.publicKey)) / 1e9}`);

  // identity — owner is a COMMITMENT, no pubkey
  const name = randFr();             // stand-in for Poseidon(label) of e.g. "alice.null"
  const secret = randFr();
  const commitment = poseidon2([secret, name]);
  const nameBytes = dec2be32(name);
  const [namePda] = PublicKey.findProgramAddressSync([Buffer.from("null_name"), nameBytes], prog);
  console.log(` name_pda ${namePda.toBase58()}  (owner = commitment, wallet unlinkable)`);

  // (1) register — requires an ownership proof (anti-brick: only someone who knows the secret can claim)
  console.log("\n[1] register (commitment + ownership proof; anti-brick)");
  const ahReg = poseidon3([3n, commitment, 0n]); // DOMAIN_REGISTER=3, seq=0
  const regProof = ownershipProof({ name, commitment, secret, action_hash: ahReg });
  await send(new TransactionInstruction({ programId: prog, keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: namePda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }],
    data: Buffer.concat([Buffer.from([0x00]), nameBytes, dec2be32(commitment), regProof]) }), "register");

  // (2) set_record — manage site via ownership proof (seq=0). Note: name_pda is the ONLY ix account.
  console.log("\n[2] set_record (ZK-authorized; fee-payer is NOT an instruction account)");
  const content_ptr = randFr();
  const ah0 = poseidon3([DOMAIN_SETRECORD, content_ptr, 0n]);
  const proof0 = ownershipProof({ name, commitment, secret, action_hash: ah0 });
  const setData = Buffer.concat([Buffer.from([0x01]), nameBytes, proof0, dec2be32(commitment), dec2be32(content_ptr)]);
  await send(new TransactionInstruction({ programId: prog, keys: [{ pubkey: namePda, isSigner: false, isWritable: true }], data: setData }), "set_record");
  let rec = await readRec(namePda);
  const contentOk = Buffer.compare(rec.slice(32, 64), dec2be32(content_ptr)) === 0;
  const seq1 = Number(Buffer.from(rec.slice(64, 72)).readBigUInt64LE());
  console.log(`  content updated: ${contentOk}, seq: ${seq1}`);
  if (!contentOk || seq1 !== 1) throw new Error("set_record state wrong");

  // (3) transfer — re-commit to a new owner (old owner proves; binds new_commitment + seq=1)
  console.log("\n[3] transfer (re-commit to new owner)");
  const newSecret = randFr();
  const newCommitment = poseidon2([newSecret, name]);
  const ahT = poseidon3([DOMAIN_TRANSFER, newCommitment, 1n]);
  const proofT = ownershipProof({ name, commitment, secret, action_hash: ahT });
  const xferData = Buffer.concat([Buffer.from([0x02]), nameBytes, proofT, dec2be32(commitment), dec2be32(newCommitment)]);
  await send(new TransactionInstruction({ programId: prog, keys: [{ pubkey: namePda, isSigner: false, isWritable: true }], data: xferData }), "transfer");
  rec = await readRec(namePda);
  const commitChanged = Buffer.compare(rec.slice(0, 32), dec2be32(newCommitment)) === 0;
  const seq2 = Number(Buffer.from(rec.slice(64, 72)).readBigUInt64LE());
  console.log(`  commitment changed to new owner: ${commitChanged}, seq: ${seq2}`);
  if (!commitChanged || seq2 !== 2) throw new Error("transfer state wrong");

  // Negatives are judged by ON-CHAIN STATE, not the tx error: devnet's public RPC sometimes
  // returns err=null under 429 load for a tx that actually reverted, so a real attack is one that
  // CHANGES state (seq bump / PDA created). trySend submits + never throws.
  const trySend = async (ix, label) => {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: payer.publicKey })
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 + (sendNonce++) })).add(ix);
    tx.sign(payer);
    let err = null; try { const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true }); err = (await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed")).value.err; } catch (e) { err = e.message; }
    console.log(`  [${label}] tx err=${JSON.stringify(err)} (verdict from on-chain state)`);
  };
  const seqOf = async () => Number(Buffer.from((await readRec(namePda)).slice(64, 72)).readBigUInt64LE());

  // (4) replay old set_record proof — must have NO EFFECT (seq unchanged)
  console.log("\n[4] replay old set_record proof — expect NO state change");
  const seqBefore = await seqOf();
  await trySend(new TransactionInstruction({ programId: prog, keys: [{ pubkey: namePda, isSigner: false, isWritable: true }], data: setData }), "replay-setrecord");
  const replayNoop = (await seqOf()) === seqBefore;
  console.log(`  seq unchanged at ${seqBefore} → replay had no effect: ${replayNoop}`);
  if (!replayNoop) throw new Error("replay mutated state");

  // (5) forge: valid proof for attacker's OWN commitment, used on victim's name — must have NO EFFECT
  console.log("\n[5] forge attempt: attacker's proof on victim's name — expect NO state change");
  const atkSecret = randFr(), atkCommit = poseidon2([atkSecret, name]);
  const ahF = poseidon3([DOMAIN_SETRECORD, content_ptr, BigInt(seqBefore)]);
  const forge = ownershipProof({ name, commitment: atkCommit, secret: atkSecret, action_hash: ahF });
  const forgeData = Buffer.concat([Buffer.from([0x01]), nameBytes, forge, dec2be32(newCommitment), dec2be32(content_ptr)]);
  await trySend(new TransactionInstruction({ programId: prog, keys: [{ pubkey: namePda, isSigner: false, isWritable: true }], data: forgeData }), "forge");
  const forgeNoop = (await seqOf()) === seqBefore;
  console.log(`  seq unchanged at ${seqBefore} → forge had no effect: ${forgeNoop}`);
  if (!forgeNoop) throw new Error("forge mutated state — SOUNDNESS BUG");

  // (6) brick: register a FRESH name with a junk/unowned commitment — name must STAY FREE
  console.log("\n[6] brick attempt: junk commitment — expect name stays unregistered");
  const name2 = randFr(), name2Bytes = dec2be32(name2);
  const [name2Pda] = PublicKey.findProgramAddressSync([Buffer.from("null_name"), name2Bytes], prog);
  const junkCommit = randFr();
  const brickSecret = randFr(), brickCommit = poseidon2([brickSecret, name2]);
  const bogus = ownershipProof({ name: name2, commitment: brickCommit, secret: brickSecret, action_hash: poseidon3([3n, junkCommit, 0n]) });
  await trySend(new TransactionInstruction({ programId: prog, keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: name2Pda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }],
    data: Buffer.concat([Buffer.from([0x00]), name2Bytes, dec2be32(junkCommit), bogus]) }), "brick-attempt");
  const stillFree = (await conn.getAccountInfo(name2Pda, "confirmed")) === null;
  console.log(`  name2 still unregistered (recoverable by real owner): ${stillFree}`);
  if (!stillFree) throw new Error("brick: name2 should remain free");

  console.log("\n=== RESULT ===");
  console.log("register         : PASS (commitment + ownership proof, no pubkey)");
  console.log("set_record       : PASS (ZK-authorized, fee-payer unlinkable)");
  console.log("transfer         : PASS (re-committed to new owner)");
  console.log("replay_rejected  : PASS");
  console.log("forge_rejected   : PASS");
  console.log("brick_rejected   : PASS (junk commitment can't claim a name; stays free)");
  console.log("\nPASS: anonymous .null ownership — register/manage/transfer with no wallet↔name link on-chain.");
}
main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
