#!/usr/bin/env node
/**
 * On-chain e2e — hardened x402 access gate (x402_access_v2) on DEVNET.
 * Chain-layer half of circuits/X402_ACCESS_HARDENING_BENCH.md (the circuit-layer half is
 * x402-access-harden-bench.mjs). Proves the DEPLOYED gate accepts a real Merkle-bound access
 * proof and rejects the forges that the v1 tautology let through.
 *
 *  1. settle_and_record one REAL payment into the canonical receipt tree (tree_id=0).
 *  2. reconstruct the inserted leaf's Merkle path from the tree's pre-insert frontier
 *     (filledSubtrees + zeros) — works against any tree state, no indexer.
 *  3. snarkjs x402_access_v2 proof bound to (root, scope, epoch); assert JS root == on-chain root.
 *  4. submit to the gate — expect SUCCESS + x402_nullifier PDA created.            [L1]
 *  5. replay the same proof                              → expect Custom(3).        [A4]
 *  6. proof against a self-made tree root (fabricated leaf) → expect Custom(11).    [A3]
 *  7. same proof, swapped scope_hash public input         → expect Custom(1).       [A6]
 *
 * Env: RPC, GATE, RECEIPT_TREE, KEY (keypair json path), ART (dir with v2 wasm/zkey/vk).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const GATE = process.env.GATE ?? "Ew4kwn4BCKGb3v5uN1zD8EQzLSzALA5LetpK5qVSBoEs";
const TREEP = process.env.RECEIPT_TREE ?? "H9nL9tErFXFmr2ZGkgFVz2NpjAsAeDBXDgS85qBWFGAe";
const KEY = process.env.KEY ?? "/key.json";
const ART = process.env.ART ?? "/art";
const SNARKJS = join(process.cwd(), "node_modules", "snarkjs", "build", "cli.cjs");

const DEPTH = 10, DOMAIN_ACCESS = 11n;
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const TREE_ID = Buffer.alloc(8);
const O_NEXT = 32, O_RIDX = 40, O_FILLED = 42, O_ZEROS = 362, O_ROOTS = 682, ROOT_HISTORY = 8, TREE_LEN = 938;

const { poseidon2, poseidon4, poseidon5 } = await import("poseidon-lite");
const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram } =
  await import("@solana/web3.js");

const dec2be32 = (d) => Buffer.from(BigInt(d).toString(16).padStart(64, "0"), "hex");
const be2big = (b) => BigInt("0x" + Buffer.from(b).toString("hex"));
const g1 = (p) => Buffer.concat([dec2be32(p[0]), dec2be32(p[1])]);
const g2 = (p) => Buffer.concat([dec2be32(p[0][1]), dec2be32(p[0][0]), dec2be32(p[1][1]), dec2be32(p[1][0])]);
const randFr = () => BigInt("0x" + randomBytes(31).toString("hex")) % P;
const u64le = (x) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(x)); return b; };

const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEY, "utf8"))));
const conn = new Connection(RPC, "confirmed");
const gate = new PublicKey(GATE), treeProg = new PublicKey(TREEP);
const [treePda] = PublicKey.findProgramAddressSync([Buffer.from("receipt_tree"), TREE_ID], treeProg);

const grades = [];
const grade = (id, ok, detail) => { grades.push({ id, ok }); console.log(`  [${ok ? "PASS" : "FAIL"}] ${id} — ${detail}`); };

async function send(ixs, label, { expectErr = null } = {}) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: payer.publicKey });
  ixs.forEach((i) => tx.add(i)); tx.sign(payer);
  let sig = null, err = null;
  try {
    sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    err = (await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed")).value.err;
    // confirmTransaction can race and report null on a tx that actually reverted on-chain;
    // re-read the authoritative status from the ledger so forge cases aren't flaky-passed.
    if (err == null && sig) {
      for (let i = 0; i < 6; i++) {
        const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (t?.meta) { err = t.meta.err; break; }
        await new Promise((r) => setTimeout(r, 700));
      }
    }
  } catch (e) { err = e.message; }
  return { sig, err, errStr: err == null ? "" : JSON.stringify(err) };
}
async function logsOf(sig) {
  for (let i = 0; i < 10; i++) {
    const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (t?.meta?.logMessages) return t.meta.logMessages;
    await new Promise((r) => setTimeout(r, 800));
  }
  return [];
}
function parseTree(d) {
  return {
    next: Number(d.readBigUInt64LE(O_NEXT)),
    filled: Array.from({ length: DEPTH }, (_, i) => be2big(d.slice(O_FILLED + i * 32, O_FILLED + i * 32 + 32))),
    zeros: Array.from({ length: DEPTH }, (_, i) => be2big(d.slice(O_ZEROS + i * 32, O_ZEROS + i * 32 + 32))),
    roots: Array.from({ length: ROOT_HISTORY }, (_, i) => be2big(d.slice(O_ROOTS + i * 32, O_ROOTS + i * 32 + 32))),
  };
}
function rootFromPath(leaf, el, ix) {
  let h = leaf;
  for (let i = 0; i < DEPTH; i++) h = ix[i] === 0 ? poseidon2([h, el[i]]) : poseidon2([el[i], h]);
  return h;
}
function prove(input) {
  const tmp = mkdtempSync(join(tmpdir(), "ax-")); const inP = join(tmp, "in.json"), pf = join(tmp, "p.json"), pub = join(tmp, "pub.json");
  writeFileSync(inP, JSON.stringify(input));
  execFileSync(process.execPath, [SNARKJS, "groth16", "fullprove", inP, join(ART, "x402_access_v2.wasm"), join(ART, "x402_access_v2_final.zkey"), pf, pub], { stdio: "pipe" });
  execFileSync(process.execPath, [SNARKJS, "groth16", "verify", join(ART, "x402_access_v2_vk.json"), pub, pf], { stdio: "pipe" });
  const proof = JSON.parse(readFileSync(pf, "utf8")), pubj = JSON.parse(readFileSync(pub, "utf8"));
  rmSync(tmp, { recursive: true, force: true });
  return { proofBytes: Buffer.concat([g1(proof.pi_a), g2(proof.pi_b), g1(proof.pi_c)]), pub: pubj };
}
function gateIx(proofBytes, pub) {
  const nullifier = pub[4];
  const [nullPda] = PublicKey.findProgramAddressSync([Buffer.from("x402_nullifier"), dec2be32(nullifier)], gate);
  const data = Buffer.concat([proofBytes, ...pub.map(dec2be32)]);
  if (data.length !== 448) throw new Error(`ix ${data.length} != 448`);
  return new TransactionInstruction({ programId: gate, keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: treePda, isSigner: false, isWritable: false },
    { pubkey: nullPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }], data });
}

async function main() {
  console.log(`\n=== x402 access gate v2 — on-chain e2e (devnet) ===`);
  console.log(` payer ${payer.publicKey.toBase58()}  bal ${(await conn.getBalance(payer.publicKey)) / 1e9}`);
  console.log(` gate  ${GATE}\n receipt_tree ${treePda.toBase58()}`);

  // identity + scope
  const secret = randFr(), agent_id = randFr(), epoch = 7n, scope_hash = randFr();
  const agent_commitment = poseidon2([secret, agent_id]);
  const threshold = 1000n, amount = 5000n;

  // (1) read tree frontier BEFORE settle (to reconstruct our leaf's path), then settle.
  let treeAcc = await conn.getAccountInfo(treePda, "confirmed");
  if (!treeAcc) {
    console.log("[init] canonical tree missing — initializing (permissionless)");
    const ir = await send([new TransactionInstruction({ programId: treeProg, keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: treePda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }],
      data: Buffer.concat([Buffer.from([0x00]), TREE_ID]) })], "init-tree");
    if (ir.err) throw new Error(`init failed: ${ir.errStr}`);
    treeAcc = await conn.getAccountInfo(treePda, "confirmed");
  }
  const before = parseTree(treeAcc.data);
  const myIdx = before.next;
  const recipient = Keypair.generate().publicKey;
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: recipient, lamports: 2_000_000 })], "fund-recipient");
  const counterparty = randFr(), nonce = randFr();
  const sData = Buffer.concat([Buffer.from([0x02]), TREE_ID, dec2be32(agent_commitment), u64le(amount), dec2be32(counterparty), dec2be32(nonce)]);
  const s = await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
    new TransactionInstruction({ programId: treeProg, keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: true },
      { pubkey: treePda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }], data: sData })], "settle");
  if (s.err) throw new Error(`settle failed: ${s.errStr}`);
  const m = (await logsOf(s.sig)).map((l) => l.match(/receipt: idx=(\d+) amount=(\d+) ts=(\d+)/)).find(Boolean);
  if (!m) throw new Error("no receipt log");
  const ts = BigInt(m[3]); console.log(`\n[settle] idx=${m[1]} amount=${m[2]} ts=${ts}  sig ${s.sig.slice(0, 12)}…`);

  // (2) reconstruct path from pre-insert frontier
  const leaf = poseidon5([agent_commitment, amount, ts, counterparty, nonce]);
  const el = [], ix = []; let idx = myIdx;
  for (let i = 0; i < DEPTH; i++) { const bit = idx & 1; ix.push(bit); el.push(bit ? before.filled[i] : before.zeros[i]); idx >>= 1; }
  const root = rootFromPath(leaf, el, ix);
  const after = parseTree((await conn.getAccountInfo(treePda, "confirmed")).data);
  const rootMatch = after.roots.some((r) => r === root);
  console.log(`[path] JS root ${root.toString().slice(0, 16)}…  on-chain match: ${rootMatch}`);
  if (!rootMatch) throw new Error("reconstructed root not in on-chain history");

  // (3) build the legit proof
  const nullifier = poseidon4([DOMAIN_ACCESS, secret, scope_hash, epoch]);
  const input = { root: root.toString(), threshold: threshold.toString(), scope_hash: scope_hash.toString(),
    epoch: epoch.toString(), nullifier: nullifier.toString(), agent_commitment: agent_commitment.toString(),
    secret: secret.toString(), agent_id: agent_id.toString(), amount: amount.toString(), timestamp: ts.toString(),
    counterparty: counterparty.toString(), receipt_nonce: nonce.toString(),
    path_elements: el.map(String), path_index: ix.map(String) };
  const { proofBytes, pub } = prove(input);
  console.log(`[prove] snarkjs local verify OK (pub[root]=${pub[0].slice(0, 10)}…)`);

  // (4) L1 — submit, expect SUCCESS + nullifier PDA
  const [nullPda] = PublicKey.findProgramAddressSync([Buffer.from("x402_nullifier"), dec2be32(nullifier)], gate);
  const r1 = await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), gateIx(proofBytes, pub)], "L1");
  const created = (await conn.getAccountInfo(nullPda, "confirmed"))?.owner?.toBase58() === GATE;
  grade("L1", !r1.err && created, !r1.err ? `accepted on-chain + nullifier PDA created  sig ${r1.sig?.slice(0, 12)}…` : `rejected ${r1.errStr}`);

  // (5) A4 — replay same proof, expect Custom(3)
  const r2 = await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), gateIx(proofBytes, pub)], "A4");
  grade("A4", /Custom":3|custom program error: 0x3\b/.test(r2.errStr), r2.err ? `replay rejected ${r2.errStr}` : "replay WRONGLY accepted");

  // (6) A3 — self-made tree root (fabricated leaf), expect Custom(11)
  const fAmount = 9_000_000n, fCp = randFr(), fNonce = randFr(), fScope = randFr();
  const fLeaf = poseidon5([agent_commitment, fAmount, ts, fCp, fNonce]);
  const fEl = [], fIx = []; { let j = 0; for (let i = 0; i < DEPTH; i++) { const bit = j & 1; fIx.push(bit); fEl.push(before.zeros[i]); j >>= 1; } }
  const fRoot = rootFromPath(fLeaf, fEl, fIx);
  const fNull = poseidon4([DOMAIN_ACCESS, secret, fScope, epoch]);
  const fInput = { ...input, root: fRoot.toString(), scope_hash: fScope.toString(), nullifier: fNull.toString(),
    amount: fAmount.toString(), counterparty: fCp.toString(), receipt_nonce: fNonce.toString(),
    path_elements: fEl.map(String), path_index: fIx.map(String) };
  const f = prove(fInput);
  const nowRoots = parseTree((await conn.getAccountInfo(treePda, "confirmed")).data).roots;
  console.log(`[A3 dbg] fRoot=${fRoot.toString().slice(0, 18)}…  pub[0]=${String(f.pub[0]).slice(0, 18)}…  in canonical? ${nowRoots.some((r) => r === fRoot)}`);
  const r3 = await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), gateIx(f.proofBytes, f.pub)], "A3");
  console.log(`[A3 dbg] sig=${r3.sig?.slice(0, 14)} err=${r3.errStr || "none"}`);
  grade("A3", /Custom":11|custom program error: 0xb\b/.test(r3.errStr), r3.err ? `self-made root rejected ${r3.errStr}` : "self-made root WRONGLY accepted");

  // (7) A6 — swap scope_hash public input on the (otherwise valid) L1 proof, expect Custom(1)
  const pubSwap = [...pub]; pubSwap[2] = randFr().toString(); // different scope than the proof commits to
  const r4 = await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), gateIx(proofBytes, pubSwap)], "A6");
  grade("A6", /Custom":1|custom program error: 0x1\b/.test(r4.errStr), r4.err ? `cross-scope rejected ${r4.errStr}` : "cross-scope WRONGLY accepted");

  // (8) LIVE-MESH — flow the REAL on-chain x402 access into the cross-layer receipt-DAG.
  const DAG = process.env.DAG ?? "/dag/src/index.ts";
  const { buildDagReceipt, buildX402AccessReceipt, verifyDagChain, buildDagMerkleRoot, traceProvenance, hashAction, anchorDagRoot } = await import(DAG);
  const agentId = agent_commitment.toString();
  const payment = buildDagReceipt({
    agentPubkey: agentId, layer: "payment", sequenceNonce: 0,
    actionHash: hashAction({ layer: "payment", amount: amount.toString(), leafIndex: myIdx, ts: ts.toString() }),
  });
  const accessR = buildX402AccessReceipt({
    agentPubkey: agentId, scopeHash: scope_hash.toString(), epoch: epoch.toString(), nullifier: nullifier.toString(),
    fundingReceiptId: payment.receiptId, sequenceNonce: 1, parentReceiptId: payment.receiptId,
  });
  const batch = [payment, accessR];
  const vr = verifyDagChain(batch);
  const prov = traceProvenance(accessR.receiptId, batch);
  const anchorRoot = buildDagMerkleRoot(batch).toString("hex");
  console.log(`\n[live-mesh] payment(${payment.layer}) → access(${accessR.layer})  ids ${payment.receiptId.slice(0, 10)}…/${accessR.receiptId.slice(0, 10)}…`);
  console.log(`[live-mesh] access traces layers: ${[...prov.reachedLayers].join(" + ")}   DAG valid: ${vr.valid}`);
  console.log(`[live-mesh] cross-layer anchor root: ${anchorRoot}`);

  // Anchor the cross-layer root ON-CHAIN via receipt_anchor, then verify the bucket accumulated it.
  // The access receipt is itself the x402-access node; its provenance must trace back to a payment.
  let anchoredOk = true, anchorLine = "(skipped — set ANCHOR_PROGRAM to anchor on-chain)";
  if (process.env.ANCHOR_PROGRAM) {
    const bucketId = BigInt(Date.now()); // fresh per-run bucket → starts empty, count goes 0→1
    const ar = await anchorDagRoot(batch, conn, payer, { programId: process.env.ANCHOR_PROGRAM, bucketId });
    const acc = await conn.getAccountInfo(new PublicKey(ar.bucketPda), "confirmed");
    const onRoot = acc ? Buffer.from(acc.data.slice(14, 46)).toString("hex") : "";
    const onCount = acc ? acc.data.readUInt32LE(10) : 0;
    const { createHash } = await import("node:crypto");
    const expect = createHash("sha256").update(Buffer.concat([Buffer.alloc(32), Buffer.from(ar.anchor, "hex")])).digest("hex");
    anchoredOk = onRoot === expect && onCount === 1;
    anchorLine = `tx ${ar.signature.slice(0, 12)}… bucket ${ar.bucketPda.slice(0, 8)}… count=${onCount} accumulated-root✓=${onRoot === expect}`;
  }
  console.log(`[live-mesh] on-chain anchor: ${anchorLine}`);
  const dagOk = vr.valid && accessR.layer === "x402-access" && prov.reachedLayers.has("payment") && anchoredOk;

  console.log("\n=== ON-CHAIN + LIVE-MESH GRADE ===");
  console.log(grades.map((g) => `${g.id}:${g.ok ? "PASS" : "FAIL"}`).join("  ") + `  DAG:${dagOk ? "PASS" : "FAIL"}`);
  const allPass = grades.every((g) => g.ok) && grades.length === 4 && dagOk;
  console.log(allPass
    ? "\n✅ LIVE-MESH VERIFIED: on-chain x402 access (legit accepted; replay/self-made-root/cross-scope rejected) → flowed into the cross-layer DAG → access traces to its funding payment → anchor root computed."
    : "\n❌ GRADE FAILED — see FAIL rows.");
  process.exit(allPass ? 0 : 1);
}
main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
