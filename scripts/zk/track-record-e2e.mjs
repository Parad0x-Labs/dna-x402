#!/usr/bin/env node
/**
 * dark_reputation_gate — full on-chain e2e (positive + negatives).
 *
 *   1. Build a Poseidon receipt Merkle tree (K real receipts in a depth-D tree)
 *      EXACTLY matching track_record.circom (poseidon-lite == circomlib).
 *   2. Generate a real Groth16 proof (snarkjs) that K receipts in the tree, in-window,
 *      distinct, total >= min_volume, count >= min_count.
 *   3. Off-chain verify. Submit on-chain (confirm). Then negatives, all rejected:
 *        forged proof / tampered public input (min_volume) / zero proof.
 *
 * Usage: node scripts/zk/track-record-e2e.mjs --program <ID> --cluster devnet|mainnet-beta
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i !== -1 ? process.argv[i + 1] : d; };
const PROGRAM_ID = arg("program");
const CLUSTER = arg("cluster", "devnet");
const RPC = arg("rpc", CLUSTER === "mainnet-beta" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");

const SNARKJS = join(REPO, ".tools", "external", "dark-null-protocol", "node_modules", "snarkjs", "build", "cli.cjs");
const WASM = join(REPO, "circuits", "out", "track_record_js", "track_record.wasm");
const ZKEY = join(REPO, "circuits", "out", "track_record_final.zkey");
const VK = join(REPO, "circuits", "out", "track_record_vk.json");
const EVID = join(REPO, "evidence", "zk");

const K = 4, DEPTH = 10, DOMAIN_REP = 7n;
const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n; // BN254 Fr

const decToBytes32 = (d) => Buffer.from(BigInt(d).toString(16).padStart(64, "0"), "hex");
const g1ToBytes64  = (p) => Buffer.concat([decToBytes32(p[0]), decToBytes32(p[1])]);
const g2ToBytes128 = (p) => Buffer.concat([decToBytes32(p[0][1]), decToBytes32(p[0][0]), decToBytes32(p[1][1]), decToBytes32(p[1][0])]);
const randFr = () => BigInt("0x" + randomBytes(31).toString("hex")) % P;

async function main() {
  if (!PROGRAM_ID) throw new Error("--program <ID> required");
  const { poseidon2, poseidon3, poseidon5 } = await import("poseidon-lite");
  const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram } = await import("@solana/web3.js");

  // ── identity + receipts ────────────────────────────────────────────────────
  const secret = randFr(), agent_id = randFr(), epoch = 42n;
  const agent_commitment = poseidon2([secret, agent_id]);
  const reputation_nullifier = poseidon3([DOMAIN_REP, secret, epoch]);

  const now = 1780000000n;
  const window_start = now - 90n * 86400n;
  const idxs = [3n, 17n, 88n, 511n].slice(0, K);          // strictly increasing, < 2^DEPTH
  const receipts = idxs.map((_, i) => ({
    amount: BigInt(2000 + i * 1500),                        // settled amounts
    timestamp: now - BigInt((i + 1) * 5 * 86400),           // within 90d
    counterparty: randFr(),
    nonce: randFr(),
  }));
  const leaves = receipts.map((r) => poseidon5([agent_commitment, r.amount, r.timestamp, r.counterparty, r.nonce]));
  const totalVolume = receipts.reduce((a, r) => a + r.amount, 0n);

  // ── build the depth-D Poseidon tree (zeros elsewhere), matching the circuit ──
  let level = new Array(1 << DEPTH).fill(0n);
  idxs.forEach((idx, i) => { level[Number(idx)] = leaves[i]; });
  const tree = [level];
  for (let d = 0; d < DEPTH; d++) {
    const next = new Array(level.length >> 1);
    for (let i = 0; i < next.length; i++) next[i] = poseidon2([level[2 * i], level[2 * i + 1]]);
    tree.push(next); level = next;
  }
  const root = tree[DEPTH][0];
  const pathOf = (idx) => {
    const elements = [], index = [];
    let i = Number(idx);
    for (let d = 0; d < DEPTH; d++) {
      const bit = i & 1; index.push(bit);
      elements.push(tree[d][bit ? i - 1 : i + 1]);
      i >>= 1;
    }
    return { elements, index };
  };
  const paths = idxs.map(pathOf);

  // ── circuit witness ─────────────────────────────────────────────────────────
  const min_count = 3n, min_volume = totalVolume - 1n;
  const input = {
    root: root.toString(), min_count: min_count.toString(), min_volume: min_volume.toString(),
    window_start: window_start.toString(), reputation_nullifier: reputation_nullifier.toString(),
    agent_commitment: agent_commitment.toString(),
    secret: secret.toString(), agent_id: agent_id.toString(), epoch: epoch.toString(),
    amount: receipts.map((r) => r.amount.toString()),
    timestamp: receipts.map((r) => r.timestamp.toString()),
    counterparty: receipts.map((r) => r.counterparty.toString()),
    receipt_nonce: receipts.map((r) => r.nonce.toString()),
    leaf_index: idxs.map((x) => x.toString()),
    path_elements: paths.map((p) => p.elements.map((e) => e.toString())),
    path_index: paths.map((p) => p.index.map((b) => b.toString())),
  };

  console.log(`dark_reputation_gate e2e — ${CLUSTER}  program ${PROGRAM_ID}`);
  console.log(`  ${K} receipts, depth ${DEPTH}, total ${totalVolume} >= min_volume ${min_volume}, count >= ${min_count}`);

  const tmp = await mkdtemp(join(tmpdir(), "trk-"));
  const inP = join(tmp, "in.json"), pfP = join(tmp, "p.json"), pubP = join(tmp, "pub.json");
  await writeFile(inP, JSON.stringify(input));
  execFileSync(process.execPath, [SNARKJS, "groth16", "fullprove", inP, WASM, ZKEY, pfP, pubP], { stdio: "pipe" });
  const proof = JSON.parse(readFileSync(pfP, "utf8"));
  const pub = JSON.parse(readFileSync(pubP, "utf8"));
  execFileSync(process.execPath, [SNARKJS, "groth16", "verify", VK, pubP, pfP], { stdio: "pipe" });
  console.log(`  off-chain verify: PASS  (public order: ${pub.map((s) => s.slice(0, 6)).join(", ")})`);

  // ── 448-byte wire: proof[256] + 6 public inputs (circuit order) ─────────────
  const proofBytes = Buffer.concat([g1ToBytes64(proof.pi_a), g2ToBytes128(proof.pi_b), g1ToBytes64(proof.pi_c)]);
  const pubBytes = Buffer.concat(pub.map((s) => decToBytes32(s)));   // root,min_count,min_volume,window_start,nullifier,commitment
  const realData = Buffer.concat([proofBytes, pubBytes]);
  if (realData.length !== 448) throw new Error(`payload ${realData.length} != 448`);

  const keyPath = execSync("solana config get", { encoding: "utf8" }).match(/Keypair Path:\s+(.+)/)?.[1]?.trim();
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
  const conn = new Connection(RPC, "confirmed");
  const pid = new PublicKey(PROGRAM_ID);
  // single-use enforcement: the gate CPIs dark_nullifier_record to record reputation_nullifier
  const NULLIFIER_RECORD = new PublicKey("24tmjEd1DhPW2QuPV6BzkFFHrq2PtELoLqv5cuv2Xu65");
  const nullifierBytes = decToBytes32(pub[4]); // reputation_nullifier, big-endian 32
  const [recordPda] = PublicKey.findProgramAddressSync([Buffer.from("null_record"), nullifierBytes], NULLIFIER_RECORD);
  const keys = [
    { pubkey: payer.publicKey,        isSigner: true,  isWritable: true  },
    { pubkey: NULLIFIER_RECORD,        isSigner: false, isWritable: false },
    { pubkey: recordPda,               isSigner: false, isWritable: true  },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  const mkTx = async (data) => {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: payer.publicKey })
      .add(new TransactionInstruction({ programId: pid, keys, data }));
    tx.sign(payer); return { tx, blockhash, lastValidBlockHeight };
  };

  const { tx, blockhash, lastValidBlockHeight } = await mkTx(realData);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log(`  ON-CHAIN positive: CONFIRMED  ${sig}`);

  const simRej = async (label, data) => {
    const { tx } = await mkTx(data);
    const err = (await conn.simulateTransaction(tx)).value.err;
    const r = err !== null;
    console.log(`  ON-CHAIN negative [${label}]: ${r ? "REJECTED" : "!! ACCEPTED (FAIL)"}  err=${JSON.stringify(err)}`);
    return r;
  };
  const forged = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => (i * 7 + 3) & 0xff)), pubBytes]);
  const tampered = Buffer.concat([proofBytes, decToBytes32(pub[0]), decToBytes32(pub[1]), decToBytes32((BigInt(pub[2]) + 10n ** 18n).toString()), ...pub.slice(3).map((s) => decToBytes32(s))]);
  const zero = Buffer.concat([Buffer.alloc(256), pubBytes]);
  const n0 = await simRej("replay-same-nullifier", realData); // single-use: nullifier already recorded
  const n1 = await simRej("forged-proof", forged);
  const n2 = await simRej("tampered-min_volume", tampered);
  const n3 = await simRej("zero-proof", zero);
  const pass = n0 && n1 && n2 && n3;
  if (!pass) { console.error("SECURITY FAIL"); await rm(tmp, { recursive: true, force: true }); process.exit(1); }

  mkdirSync(EVID, { recursive: true });
  writeFileSync(join(EVID, `track-record-${CLUSTER}.json`), JSON.stringify({
    test: "dark_reputation_gate-onchain-e2e", cluster: CLUSTER, program: PROGRAM_ID,
    circuit: "track_record.circom", params: { K, depth: DEPTH }, curve: "bn254", protocol: "groth16",
    publicInputs: { root: pub[0], min_count: pub[1], min_volume: pub[2], window_start: pub[3], reputation_nullifier: pub[4], agent_commitment: pub[5] },
    nullifierRecordPda: recordPda.toBase58(),
    tests: { offChainVerify: "PASS", onChainRealProof: { result: "CONFIRMED", tx: sig }, onChainReplaySameNullifier: "REJECTED (single-use)", onChainForged: "REJECTED", onChainTamperedMinVolume: "REJECTED", onChainZero: "REJECTED" },
    explorer: `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`,
  }, null, 2) + "\n");
  await rm(tmp, { recursive: true, force: true });
  console.log(`\nRESULT (${CLUSTER}): real track-record proof CONFIRMED; forged + tampered + zero all REJECTED.`);
}
main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
