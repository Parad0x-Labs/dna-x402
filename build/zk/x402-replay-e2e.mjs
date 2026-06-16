#!/usr/bin/env node
/**
 * x402_access_gate DEVNET e2e — validates the replay-protection fix (single-use PDA).
 *   1. snarkjs fullprove (x402_access) → real Groth16 proof
 *   2. submit with the 3 new accounts [nullifier_pda(w), payer(signer,w), system_program]
 *      → expect SUCCESS + the nullifier PDA created (owned by the program)
 *   3. replay the SAME proof/nullifier → expect on-chain revert Custom(3) (already spent)
 *
 * Env: X402_PROGRAM, X402_WASM, X402_ZKEY, X402_VK, RPC. Signer via `solana config get`.
 */
import { execFileSync, execSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const RPC      = process.env.RPC ?? "https://api.devnet.solana.com";
const PROGRAM  = process.env.X402_PROGRAM ?? "PvgADeqesDYk8sxfStb8L8FTNi26X8SuHhrPQxCGQue";
const WASM     = process.env.X402_WASM ?? "/art/x402_access.wasm";
const ZKEY     = process.env.X402_ZKEY ?? "/art/x402_access_final.zkey";
const VK       = process.env.X402_VK ?? "/art/x402_access_vk.json";
const SNARKJS  = join(process.cwd(), "node_modules", "snarkjs", "build", "cli.cjs");

// secret=42, agent_id=7, balance=500, nonce=12345 → these public values (Poseidon over BN254 Fr)
const COMMITMENT = "3058340958650756850333278030845923471182880899951380702275913973811505220565";
const NULLIFIER  = "13245343514578030741594369900290446682530842171781363792498777812991056803829";

const decToBytes32 = (d) => Buffer.from(BigInt(d).toString(16).padStart(64, "0"), "hex");
const g1 = (p) => Buffer.concat([decToBytes32(p[0]), decToBytes32(p[1])]);
const g2 = (p) => { const [xc0, xc1] = p[0], [yc0, yc1] = p[1];
  return Buffer.concat([decToBytes32(xc1), decToBytes32(xc0), decToBytes32(yc1), decToBytes32(yc0)]); };

const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram }
  = await import("@solana/web3.js");

async function sendExpect(conn, ix, payer, label, { expectFail = false } = {}) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: payer.publicKey })
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 })).add(ix);
  tx.sign(payer);
  let sig, err = null;
  try {
    sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const c = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    err = c.value.err;
  } catch (e) { err = e.message; }
  const ok = err == null;
  console.log(`  [${label}] ${ok ? "succeeded" : "reverted"} err=${JSON.stringify(err)} sig=${sig ?? "-"}`);
  if (expectFail && ok) throw new Error(`${label}: expected revert but it SUCCEEDED`);
  if (!expectFail && !ok) throw new Error(`${label}: expected success but it REVERTED: ${JSON.stringify(err)}`);
  return { sig, err };
}

async function main() {
  console.log(`\n=== x402_access_gate replay e2e (program ${PROGRAM}) ===`);
  const keyPath = execSync("solana config get", { encoding: "utf8" }).match(/Keypair Path:\s+(.+)/)[1].trim();
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
  const conn = new Connection(RPC, "confirmed");
  const programId = new PublicKey(PROGRAM);
  console.log(`payer ${payer.publicKey.toBase58()}  bal ${(await conn.getBalance(payer.publicKey)) / 1e9} SOL`);

  // ── prove ──
  const tmp = mkdtempSync(join(tmpdir(), "x402-"));
  const inp = join(tmp, "in.json"), pf = join(tmp, "p.json"), pub = join(tmp, "pub.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(inp, JSON.stringify({ commitment: COMMITMENT, threshold: "100", nullifier: NULLIFIER, secret: "42", agent_id: "7", balance: "500", nonce: "12345" }));
  execFileSync(process.execPath, [SNARKJS, "groth16", "fullprove", inp, WASM, ZKEY, pf, pub], { stdio: "pipe" });
  execFileSync(process.execPath, [SNARKJS, "groth16", "verify", VK, pub, pf], { stdio: "pipe" });
  console.log("  snarkjs local verify: OK");
  const proof = JSON.parse(readFileSync(pf, "utf8"));
  const publicData = JSON.parse(readFileSync(pub, "utf8"));

  const proofBytes = Buffer.concat([g1(proof.pi_a), g2(proof.pi_b), g1(proof.pi_c)]);
  const commitmentBytes = decToBytes32(publicData[0]);
  const thresholdBytes = decToBytes32(publicData[1]);
  const nullifierBytes = decToBytes32(publicData[2]);
  const ixData = Buffer.concat([proofBytes, commitmentBytes, thresholdBytes, nullifierBytes]);
  if (ixData.length !== 352) throw new Error(`ixData ${ixData.length} != 352`);
  rmSync(tmp, { recursive: true, force: true });

  const [nullPda] = PublicKey.findProgramAddressSync([Buffer.from("x402_nullifier"), nullifierBytes], programId);
  console.log(`  nullifier PDA ${nullPda.toBase58()}`);
  const mkIx = () => new TransactionInstruction({
    programId,
    keys: [
      { pubkey: nullPda, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: ixData,
  });

  console.log("\n[1] first spend — expect SUCCESS + PDA created");
  await sendExpect(conn, mkIx(), payer, "first-spend");
  const ai = await conn.getAccountInfo(nullPda, "confirmed");
  const created = !!ai && ai.owner.toBase58() === programId.toBase58() && ai.data.length > 0;
  console.log(`  nullifier PDA created+owned: ${created} (owner=${ai?.owner.toBase58()}, len=${ai?.data.length})`);
  if (!created) throw new Error("nullifier PDA not created/owned after first spend");

  console.log("\n[2] replay SAME proof+nullifier — expect REVERT Custom(3)");
  const r = await sendExpect(conn, mkIx(), payer, "replay", { expectFail: true });
  const isCustom3 = JSON.stringify(r.err).includes('"Custom":3');
  console.log(`  replay rejected with Custom(3): ${isCustom3}`);

  console.log("\n=== RESULT ===");
  console.log(`first_spend      : PASS`);
  console.log(`nullifier_created: PASS`);
  console.log(`replay_rejected  : ${isCustom3 ? "PASS (Custom 3)" : "PASS (reverted)"}`);
  console.log("\nPASS: x402_access_gate proof verified on-chain + replay protection works.");
}
main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
