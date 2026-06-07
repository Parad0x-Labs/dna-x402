#!/usr/bin/env node
/**
 * x402_access gate — full on-chain e2e (positive + negative).
 *
 *   1. Generate a real Groth16 proof (snarkjs) for the x402_access circuit.
 *   2. Off-chain verify (must pass).
 *   3. ON-CHAIN positive: submit real proof -> tx confirms.
 *   4. ON-CHAIN negatives (simulated against the live program):
 *        a. forged proof (random bytes)      -> rejected
 *        b. tampered public input (threshold) -> rejected
 *        c. zero proof                        -> rejected
 *   5. Write clean evidence.
 *
 * Usage:
 *   node scripts/zk/x402-access-full-e2e.mjs --program <ID> --cluster devnet|mainnet-beta
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i !== -1 ? process.argv[i + 1] : d; };

const PROGRAM_ID = arg("program", "7LZzJnLSCCu2enc7mXz9FFCbomotME78xFG4eqkpo5U6");
const CLUSTER    = arg("cluster", "devnet");
const RPC        = arg("rpc", CLUSTER === "mainnet-beta" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");

const SNARKJS = join(REPO, ".tools", "external", "dark-null-protocol", "node_modules", "snarkjs", "build", "cli.cjs");
const WASM    = join(REPO, "circuits", "out", "x402_access_js", "x402_access.wasm");
const ZKEY    = join(REPO, "circuits", "out", "x402_access_final.zkey");
const VK      = join(REPO, "circuits", "out", "x402_access_vk.json");
const EVIDENCE= join(REPO, "evidence", "zk");

const COMMITMENT = "3058340958650756850333278030845923471182880899951380702275913973811505220565";
const NULLIFIER  = "13245343514578030741594369900290446682530842171781363792498777812991056803829";

const decToBytes32 = (d) => Buffer.from(BigInt(d).toString(16).padStart(64, "0"), "hex");
const g1ToBytes64  = (p) => Buffer.concat([decToBytes32(p[0]), decToBytes32(p[1])]);
const g2ToBytes128 = (p) => Buffer.concat([decToBytes32(p[0][1]), decToBytes32(p[0][0]), decToBytes32(p[1][1]), decToBytes32(p[1][0])]);

async function main() {
  console.log(`x402_access gate e2e — ${CLUSTER}  program ${PROGRAM_ID}`);
  const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } = await import("@solana/web3.js");
  const tmp = await mkdtemp(join(tmpdir(), "x402-e2e-"));
  const inputPath = join(tmp, "input.json"), proofPath = join(tmp, "proof.json"), publicPath = join(tmp, "public.json");

  // 1. real proof
  await writeFile(inputPath, JSON.stringify({ commitment: COMMITMENT, threshold: "100", nullifier: NULLIFIER, secret: "42", agent_id: "7", balance: "500", nonce: "12345" }));
  execFileSync(process.execPath, [SNARKJS, "groth16", "fullprove", inputPath, WASM, ZKEY, proofPath, publicPath], { stdio: "pipe" });
  const proofData = JSON.parse(readFileSync(proofPath, "utf8"));
  const publicData = JSON.parse(readFileSync(publicPath, "utf8"));
  console.log(`  proof: ${proofData.protocol}/${proofData.curve}  public=[${publicData.map(s => s.slice(0,8)).join(",")}]`);

  // 2. off-chain verify
  execFileSync(process.execPath, [SNARKJS, "groth16", "verify", VK, publicPath, proofPath], { stdio: "pipe" });
  console.log("  off-chain verify: PASS");

  // build 352-byte payload
  const proofBytes = Buffer.concat([g1ToBytes64(proofData.pi_a), g2ToBytes128(proofData.pi_b), g1ToBytes64(proofData.pi_c)]);
  const realData = Buffer.concat([proofBytes, decToBytes32(publicData[0]), decToBytes32(publicData[1]), decToBytes32(publicData[2])]);
  if (realData.length !== 352) throw new Error(`payload ${realData.length} != 352`);

  const keyPath = execSync("solana config get", { encoding: "utf8" }).match(/Keypair Path:\s+(.+)/)?.[1]?.trim();
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
  const conn = new Connection(RPC, "confirmed");
  const pid = new PublicKey(PROGRAM_ID);
  const mkTx = async (data) => {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: payer.publicKey })
      .add(new TransactionInstruction({ programId: pid, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: false }], data }));
    tx.sign(payer);
    return { tx, blockhash, lastValidBlockHeight };
  };

  // 3. positive: submit real proof, confirm
  const { tx, blockhash, lastValidBlockHeight } = await mkTx(realData);
  const txSig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await conn.confirmTransaction({ signature: txSig, blockhash, lastValidBlockHeight }, "confirmed");
  console.log(`  ON-CHAIN positive: CONFIRMED  ${txSig}`);

  // 4. negatives: simulate against the live program, must error
  const simRejects = async (label, data) => {
    const { tx } = await mkTx(data);
    const sim = await conn.simulateTransaction(tx);
    const rejected = sim.value.err !== null;
    console.log(`  ON-CHAIN negative [${label}]: ${rejected ? "REJECTED" : "!! ACCEPTED (FAIL)"}  err=${JSON.stringify(sim.value.err)}`);
    return rejected;
  };
  const forged = Buffer.concat([Buffer.from(Array.from({length:256},(_,i)=>(i*7+3)&0xff)), decToBytes32(publicData[0]), decToBytes32(publicData[1]), decToBytes32(publicData[2])]);
  const tampered = Buffer.concat([proofBytes, decToBytes32(publicData[0]), decToBytes32("9999"), decToBytes32(publicData[2])]);
  const zero = Buffer.concat([Buffer.alloc(256), decToBytes32(publicData[0]), decToBytes32(publicData[1]), decToBytes32(publicData[2])]);
  const negForged   = await simRejects("forged-proof", forged);
  const negTampered = await simRejects("tampered-threshold", tampered);
  const negZero     = await simRejects("zero-proof", zero);

  const allNegPass = negForged && negTampered && negZero;
  if (!allNegPass) { console.error("SECURITY FAIL: a forged/tampered proof was accepted on-chain"); await rm(tmp, {recursive:true,force:true}); process.exit(1); }

  // 5. clean evidence
  mkdirSync(EVIDENCE, { recursive: true });
  const ev = {
    test: "x402_access-gate-onchain-e2e",
    cluster: CLUSTER,
    program: PROGRAM_ID,
    circuit: "x402_access.circom",
    curve: "bn254", protocol: "groth16",
    verifier: "on-chain alt_bn128_pairing syscall",
    vk: "x402_access_final.zkey (single-party setup 2026-06-01; multi-party ceremony pending before mainnet trust)",
    publicInputs: { commitment: publicData[0], threshold: publicData[1], nullifier: publicData[2] },
    tests: {
      offChainVerify: "PASS",
      onChainRealProof: { result: "CONFIRMED", tx: txSig },
      onChainForgedProof: negForged ? "REJECTED" : "ACCEPTED",
      onChainTamperedThreshold: negTampered ? "REJECTED" : "ACCEPTED",
      onChainZeroProof: negZero ? "REJECTED" : "ACCEPTED",
    },
    explorer: `https://explorer.solana.com/tx/${txSig}?cluster=${CLUSTER}`,
  };
  const out = join(EVIDENCE, `x402-access-${CLUSTER}.json`);
  writeFileSync(out, JSON.stringify(ev, null, 2) + "\n");
  await rm(tmp, { recursive: true, force: true });

  console.log(`\nRESULT (${CLUSTER}): real proof CONFIRMED on-chain; forged + tampered + zero all REJECTED.`);
  console.log(`Evidence: evidence/zk/x402-access-${CLUSTER}.json`);
}
main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
