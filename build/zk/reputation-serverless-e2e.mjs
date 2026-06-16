#!/usr/bin/env node
/**
 * SERVERLESS reputation e2e — dark_reputation_gate + receipt_commitment_tree (no authority).
 *
 *  1. init the CANONICAL receipt tree (tree_id=0) — permissionless.
 *  2. settle_and_record K real payments (payer -> recipient) → on-chain receipt leaves,
 *     capturing each on-chain `ts` from program logs (the only chain-determined field).
 *  3. rebuild the depth-10 Poseidon tree in JS (poseidon-lite == circomlib == sol_poseidon),
 *     assert the JS root == the on-chain root (binding the proof to real settlements).
 *  4. snarkjs track_record proof, submit to dark_reputation_gate with the NEW accounts
 *     [payer, receipt_tree, rep_nullifier_pda, system]. Expect SUCCESS + nullifier PDA.
 *  5. replay → expect Custom(10) (already recorded).
 *
 * Env: REP_PROGRAM, RECEIPT_TREE_PROGRAM, TRK_WASM, TRK_ZKEY, TRK_VK, RPC. Signer via solana shim.
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const REP_PROGRAM = process.env.REP_PROGRAM ?? "CVhsfWR1gkJ2wn4qjcCp2MaWqMbyj17wQikCkMtS791o";
const RECEIPT_TREE_PROGRAM = process.env.RECEIPT_TREE_PROGRAM ?? "H9nL9tErFXFmr2ZGkgFVz2NpjAsAeDBXDgS85qBWFGAe";
const WASM = process.env.TRK_WASM ?? "/art/track_record.wasm";
const ZKEY = process.env.TRK_ZKEY ?? "/art/track_record_final.zkey";
const VK = process.env.TRK_VK ?? "/art/track_record_vk.json";
const SNARKJS = join(process.cwd(), "node_modules", "snarkjs", "build", "cli.cjs");

const K = 4, DEPTH = 10, DOMAIN_REP = 7n;
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const TREE_ID = Buffer.alloc(8); // canonical [0;8]
const O_NEXT = 32, O_RIDX = 40, O_ROOTS = 682, ROOT_HISTORY = 8, TREE_LEN = 938;

const dec2be32 = (d) => Buffer.from(BigInt(d).toString(16).padStart(64, "0"), "hex");
const be2big = (buf) => BigInt("0x" + Buffer.from(buf).toString("hex"));
const g1 = (p) => Buffer.concat([dec2be32(p[0]), dec2be32(p[1])]);
const g2 = (p) => Buffer.concat([dec2be32(p[0][1]), dec2be32(p[0][0]), dec2be32(p[1][1]), dec2be32(p[1][0])]);
const randFr = () => BigInt("0x" + randomBytes(31).toString("hex")) % P;

const { poseidon2, poseidon3, poseidon5 } = await import("poseidon-lite");
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram }
  = await import("@solana/web3.js");

const keyPath = execSync("solana config get", { encoding: "utf8" }).match(/Keypair Path:\s+(.+)/)[1].trim();
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
const conn = new Connection(RPC, "confirmed");
const treeProg = new PublicKey(RECEIPT_TREE_PROGRAM);
const repProg = new PublicKey(REP_PROGRAM);
const [treePda] = PublicKey.findProgramAddressSync([Buffer.from("receipt_tree"), TREE_ID], treeProg);

async function send(ixs, signers, label, { expectFail = false } = {}) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: payer.publicKey });
  ixs.forEach((i) => tx.add(i)); tx.sign(...signers);
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

async function logsOf(sig) {
  for (let i = 0; i < 8; i++) {
    const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (t?.meta?.logMessages) return t.meta.logMessages;
    await new Promise((r) => setTimeout(r, 800));
  }
  return [];
}

async function main() {
  console.log(`\n=== SERVERLESS reputation e2e ===\n payer ${payer.publicKey.toBase58()} bal ${(await conn.getBalance(payer.publicKey)) / 1e9}`);
  console.log(` receipt_tree ${treePda.toBase58()}  rep_gate ${repProg.toBase58()}`);

  // identity
  const secret = randFr(), agent_id = randFr(), epoch = 42n;
  const agent_commitment = poseidon2([secret, agent_id]);
  const reputation_nullifier = poseidon3([DOMAIN_REP, secret, epoch]);

  // (1) init canonical tree if needed
  const treeInfo = await conn.getAccountInfo(treePda, "confirmed");
  if (!treeInfo) {
    console.log("\n[init] canonical tree (permissionless)");
    await send([new TransactionInstruction({ programId: treeProg,
      keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }, { pubkey: treePda, isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }],
      data: Buffer.concat([Buffer.from([0x00]), TREE_ID]) })], [payer], "init-tree");
  } else {
    const next = Number(Buffer.from(treeInfo.data.slice(O_NEXT, O_NEXT + 8)).readBigUInt64LE());
    if (next !== 0) { console.error(`tree already has ${next} leaves — this one-shot e2e needs a fresh canonical tree`); process.exit(3); }
  }

  // (2) settle_and_record K receipts; capture on-chain ts
  console.log(`\n[settle] ${K} real payments → receipts`);
  const recipient = Keypair.generate().publicKey; // the paid party (settlement target)
  // Pre-fund the recipient above rent-exemption so the small per-receipt transfers don't
  // leave it rent-paying (a fresh account funded below the minimum reverts InsufficientFundsForRent).
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient, lamports: 2_000_000 })], [payer], "fund-recipient");
  const receipts = [];
  for (let i = 0; i < K; i++) {
    const amount = BigInt(2000 + i * 1500), counterparty = randFr(), nonce = randFr();
    const data = Buffer.concat([Buffer.from([0x02]), TREE_ID, dec2be32(agent_commitment),
      (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(amount); return b; })(), dec2be32(counterparty), dec2be32(nonce)]);
    const sig = await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
      new TransactionInstruction({ programId: treeProg, keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: recipient, isSigner: false, isWritable: true },
        { pubkey: treePda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }], data })], [payer], `settle#${i}`);
    const logs = await logsOf(sig);
    const m = logs.map((l) => l.match(/receipt: idx=(\d+) amount=(\d+) ts=(\d+)/)).find(Boolean);
    if (!m) throw new Error(`no receipt log for settle#${i}: ${logs.join(" | ")}`);
    const ts = BigInt(m[3]);
    console.log(`    idx=${m[1]} amount=${m[2]} ts=${ts}`);
    receipts.push({ amount, timestamp: ts, counterparty, nonce, idx: BigInt(i) });
  }

  // (3) rebuild depth-10 tree (leaves at 0..K-1), assert root matches on-chain
  const leaves = receipts.map((r) => poseidon5([agent_commitment, r.amount, r.timestamp, r.counterparty, r.nonce]));
  let level = new Array(1 << DEPTH).fill(0n);
  receipts.forEach((r, i) => { level[Number(r.idx)] = leaves[i]; });
  const tree = [level];
  for (let d = 0; d < DEPTH; d++) { const nx = new Array(level.length >> 1); for (let i = 0; i < nx.length; i++) nx[i] = poseidon2([level[2*i], level[2*i+1]]); tree.push(nx); level = nx; }
  const root = tree[DEPTH][0];
  const pathOf = (idx) => { const el = [], ix = []; let i = Number(idx); for (let d = 0; d < DEPTH; d++) { const bit = i & 1; ix.push(bit); el.push(tree[d][bit ? i-1 : i+1]); i >>= 1; } return { el, ix }; };
  const paths = receipts.map((r) => pathOf(r.idx));

  const ti = await conn.getAccountInfo(treePda, "confirmed");
  const onchainRoots = []; for (let i = 0; i < ROOT_HISTORY; i++) onchainRoots.push(be2big(ti.data.slice(O_ROOTS + i*32, O_ROOTS + i*32 + 32)));
  const rootMatch = onchainRoots.some((r) => r === root);
  console.log(`\n[root] JS root ${root.toString().slice(0,18)}…  on-chain match: ${rootMatch}`);
  if (!rootMatch) throw new Error("JS root not in on-chain history — settlement/tree mismatch");

  // (4) witness + proof
  const window_start = receipts.reduce((a, r) => r.timestamp < a ? r.timestamp : a, receipts[0].timestamp) - 1n;
  const min_count = BigInt(K), min_volume = receipts.reduce((a, r) => a + r.amount, 0n) - 1n;
  const input = { root: root.toString(), min_count: min_count.toString(), min_volume: min_volume.toString(),
    window_start: window_start.toString(), reputation_nullifier: reputation_nullifier.toString(), agent_commitment: agent_commitment.toString(),
    secret: secret.toString(), agent_id: agent_id.toString(), epoch: epoch.toString(),
    amount: receipts.map((r) => r.amount.toString()), timestamp: receipts.map((r) => r.timestamp.toString()),
    counterparty: receipts.map((r) => r.counterparty.toString()), receipt_nonce: receipts.map((r) => r.nonce.toString()),
    leaf_index: receipts.map((r) => r.idx.toString()),
    path_elements: paths.map((p) => p.el.map((e) => e.toString())), path_index: paths.map((p) => p.ix.map((b) => b.toString())) };
  const tmp = mkdtempSync(join(tmpdir(), "rep-"));
  const inP = join(tmp, "in.json"), pfP = join(tmp, "p.json"), pubP = join(tmp, "pub.json");
  writeFileSync(inP, JSON.stringify(input));
  execFileSync(process.execPath, [SNARKJS, "groth16", "fullprove", inP, WASM, ZKEY, pfP, pubP], { stdio: "pipe" });
  execFileSync(process.execPath, [SNARKJS, "groth16", "verify", VK, pubP, pfP], { stdio: "pipe" });
  console.log("[prove] snarkjs local verify: OK");
  const proof = JSON.parse(readFileSync(pfP, "utf8")), pub = JSON.parse(readFileSync(pubP, "utf8"));
  rmSync(tmp, { recursive: true, force: true });

  const proofBytes = Buffer.concat([g1(proof.pi_a), g2(proof.pi_b), g1(proof.pi_c)]);
  const ixData = Buffer.concat([proofBytes, ...pub.map((s) => dec2be32(s))]);
  if (ixData.length !== 448) throw new Error(`ixData ${ixData.length} != 448`);

  const repNullBytes = dec2be32(reputation_nullifier);
  const [repNullPda] = PublicKey.findProgramAddressSync([Buffer.from("rep_nullifier"), repNullBytes], repProg);
  const mkRepIx = () => new TransactionInstruction({ programId: repProg, keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: treePda, isSigner: false, isWritable: false },
    { pubkey: repNullPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }], data: ixData });

  console.log("\n[gate] submit reputation proof — expect SUCCESS");
  await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), mkRepIx()], [payer], "rep-submit");
  const np = await conn.getAccountInfo(repNullPda, "confirmed");
  const created = !!np && np.owner.toBase58() === repProg.toBase58() && np.data.length > 0;
  console.log(`  rep_nullifier PDA created+owned: ${created}`);
  if (!created) throw new Error("rep_nullifier PDA not created");

  console.log("\n[gate] replay — expect REVERT (already-recorded)");
  // send(expectFail) returns normally on revert, throws (to main → Fatal) only if it wrongly succeeds.
  await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), mkRepIx()], [payer], "rep-replay", { expectFail: true });
  console.log("\n=== RESULT ===");
  console.log("init+settle      : PASS (serverless, payment-gated)");
  console.log("root_binding     : PASS (proof bound to on-chain receipt tree)");
  console.log("reputation_proof : PASS (verified on-chain)");
  console.log("nullifier_created: PASS");
  console.log("replay_rejected  : PASS");
  console.log("\nPASS: serverless reputation — receipts minted by real on-chain payments, proof verified on-chain.");
}
main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
