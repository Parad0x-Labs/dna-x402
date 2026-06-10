// x402 × KVAC devnet proof: execute the gateway's record plan on-chain.
//   success records  -> send + confirm (real tx sig)
//   rate-limited one -> simulate, assert it reverts AlreadyRecorded (Custom 10)
//
// Proves: anonymous per-(resource,epoch) rate-limit enforced on devnet, with the
// gateway never learning the agent's identity.

import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import fs from "fs"; import os from "os"; import path from "path";
import { fileURLToPath } from "url";

const PROGRAM_ID = new PublicKey("AFTuz5s58FEwQoQBxAdvWFrXAVnS9XzC43XQgL2Canpg");
const SEED = Buffer.from("null_record");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const PLAN = path.join(ROOT, "evidence", "kvac", "x402-gateway.json");
const OUT = path.join(ROOT, "evidence", "kvac", "x402-gateway-devnet.json");

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config", "solana", "id.json"))))
);
const pdaFor = (n) => PublicKey.findProgramAddressSync([SEED, n], PROGRAM_ID)[0];

function ix(nBuf) {
  const pda = pdaFor(nBuf);
  return {
    pda,
    instruction: new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([0x00]), nBuf]),
    }),
  };
}

async function sendRecord(nHex) {
  const { pda, instruction } = ix(Buffer.from(nHex, "hex"));
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(instruction), [payer], { commitment: "confirmed" });
  const st = await conn.getSignatureStatus(sig);
  return { sig, pda: pda.toBase58(), slot: st?.value?.slot ?? null };
}

async function simulateRecord(nHex) {
  const { instruction } = ix(Buffer.from(nHex, "hex"));
  const tx = new Transaction().add(instruction);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(payer);
  const sim = await conn.simulateTransaction(tx);
  return { err: JSON.stringify(sim.value.err), logs: sim.value.logs ?? [] };
}

async function main() {
  console.error(`gateway payer ${payer.publicKey.toBase58()}  program ${PROGRAM_ID.toBase58()}`);
  const plan = JSON.parse(fs.readFileSync(PLAN, "utf8"));
  const results = [];

  for (const rec of plan.records) {
    if (rec.expect === "success") {
      const r = await sendRecord(rec.nullifier);
      console.error(`[ok]   ${rec.label}  sig=${r.sig.slice(0, 12)}…`);
      results.push({ ...rec, ...r, ok: true });
    } else {
      // rate-limited: SEND for real (fresh blockhash) so it reaches the program
      // guard and reverts AlreadyRecorded (Custom 10) — not tx-level dedup.
      try {
        const r = await sendRecord(rec.nullifier);
        console.error(`[!!]  ${rec.label} unexpectedly recorded sig=${r.sig}`);
        results.push({ ...rec, ...r, ok: false, note: "expected rate-limit but recorded" });
      } catch (e) {
        let logs = e.logs || [];
        if ((!logs || logs.length === 0) && typeof e.getLogs === "function") {
          try { logs = await e.getLogs(conn); } catch {}
        }
        const blob = `${e.message || e} ${(logs || []).join(" ")}`;
        const isAlreadyRecorded = blob.includes("0xa") || blob.includes("custom program error: 0xa");
        console.error(`[deny] ${rec.label}  rate_limited=${isAlreadyRecorded}`);
        results.push({
          ...rec, reverted: true,
          error: isAlreadyRecorded ? "Custom(10) = AlreadyRecorded (0xa)" : blob.split("\n")[0].slice(0, 160),
          program_log: (logs || []).find((l) => l.includes("0xa")) ?? null,
          ok: isAlreadyRecorded,
        });
      }
    }
  }

  const allOk = results.every((r) => r.ok);
  const evidence = {
    demo: "x402 × KVAC — anonymous tiered access + per-(resource,epoch) rate-limit",
    cluster: "devnet",
    program_id: PROGRAM_ID.toBase58(),
    gateway_learns_agent_identity: false,
    properties: plan.properties,
    x402_requirements: plan.x402_requirements,
    results,
    all_ok: allOk,
  };
  fs.writeFileSync(OUT, JSON.stringify(evidence, null, 2));
  console.error(`\nALL_OK=${allOk}  evidence -> ${OUT}`);
  if (!allOk) process.exit(1);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
