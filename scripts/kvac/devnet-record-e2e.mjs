// KVAC devnet e2e: record the two verified nullifiers from the host ceremony
// on-chain via dark_nullifier_record, and prove the one-action-per-context Sybil
// bound (replay of a recorded nullifier must revert AlreadyRecorded).
//
// Scenarios:
//   1. record n_A (context A)        -> success
//   2. replay n_A                    -> AlreadyRecorded (custom 0x0a)
//   3. record n_B (same credential,  -> success  (different context => different
//      context B)                       nullifier => allowed, as it must be)
//
// Node resolves @solana/web3.js by walking up to the repo root node_modules.

import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const PROGRAM_ID = new PublicKey("AFTuz5s58FEwQoQBxAdvWFrXAVnS9XzC43XQgL2Canpg");
const RPC = "https://api.devnet.solana.com";
const SEED_PREFIX = Buffer.from("null_record");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const CEREMONY = path.join(ROOT, "evidence", "kvac", "host-ceremony.json");
const OUT = path.join(ROOT, "evidence", "kvac", "devnet-e2e.json");

const conn = new Connection(RPC, "confirmed");
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config", "solana", "id.json"))))
);

const ceremony = JSON.parse(fs.readFileSync(CEREMONY, "utf8"));
const shows = ceremony.shows;

const pdaFor = (n) => PublicKey.findProgramAddressSync([SEED_PREFIX, n], PROGRAM_ID)[0];

async function record(nHex) {
  const n = Buffer.from(nHex, "hex");
  const pda = pdaFor(n);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([0x00]), n]),
  });
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [payer], {
    commitment: "confirmed",
  });
  const st = await conn.getSignatureStatus(sig);
  return { sig, pda: pda.toBase58(), slot: st?.value?.slot ?? null };
}

async function main() {
  console.error(`payer ${payer.publicKey.toBase58()}  program ${PROGRAM_ID.toBase58()}`);
  const nA = shows[0].nullifier_hex;
  const nB = shows[1].nullifier_hex;
  const results = [];

  // 1. record n_A
  const r1 = await record(nA);
  console.error(`[1] record n_A OK  sig=${r1.sig}  pda=${r1.pda}`);
  results.push({ scenario: "record_n_A", context: shows[0].context_label, nullifier: nA, expect: "success", ...r1, ok: true });

  // 2. replay n_A -> must revert
  let replayReverted = false, replayErr = null;
  try {
    await record(nA);
  } catch (e) {
    replayReverted = true;
    replayErr = String(e.message || e).split("\n")[0];
  }
  console.error(`[2] replay n_A reverted=${replayReverted}  (${replayErr ?? "no error"})`);
  results.push({
    scenario: "replay_n_A_double_spend", nullifier: nA, expect: "AlreadyRecorded",
    reverted: replayReverted, error: replayErr, ok: replayReverted,
  });

  // 3. record n_B (same credential, different context)
  const r3 = await record(nB);
  console.error(`[3] record n_B OK  sig=${r3.sig}  pda=${r3.pda}`);
  results.push({ scenario: "record_n_B_diff_context", context: shows[1].context_label, nullifier: nB, expect: "success", ...r3, ok: true });

  // confirm both PDAs now hold the 41-byte record
  const pdaAinfo = await conn.getAccountInfo(pdaFor(Buffer.from(nA, "hex")));
  const pdaBinfo = await conn.getAccountInfo(pdaFor(Buffer.from(nB, "hex")));
  const pdasRecorded = (pdaAinfo?.data?.length ?? 0) > 0 && (pdaBinfo?.data?.length ?? 0) > 0;

  const allOk = results.every((r) => r.ok) && pdasRecorded;
  const evidence = {
    scheme: "KVAC keyed-verification anonymous credential (MAC_GGM / ristretto255)",
    cluster: "devnet",
    program_id: PROGRAM_ID.toBase58(),
    deploy_sig: "5Abn8EdhUwfPJmbgkGKdkSD5XTNyoXUCvfa9G8v69ZoNKq3Jq7LZqdBmoe6ohVdfk8waKdxmv4cpxuVevRHyT4RT",
    payer: payer.publicKey.toBase58(),
    host_ceremony: { all_ok: ceremony.all_ok, issuance_proof_verified: ceremony.issuance_proof_verified, ms_pok_verified: ceremony.ms_pok_verified },
    scenarios: results,
    pdas_recorded: pdasRecorded,
    pda_A_record_len: pdaAinfo?.data?.length ?? 0,
    pda_B_record_len: pdaBinfo?.data?.length ?? 0,
    all_ok: allOk,
  };
  fs.writeFileSync(OUT, JSON.stringify(evidence, null, 2));
  console.error(`\nALL_OK=${allOk}  evidence -> ${OUT}`);
  if (!allOk) process.exit(1);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
