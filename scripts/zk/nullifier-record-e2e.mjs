#!/usr/bin/env node
/**
 * dark_nullifier_record — on-chain anti-replay e2e.
 *
 *   1. Record a fresh nullifier        -> tx confirms (PDA created).
 *   2. Re-record the SAME nullifier     -> REJECTED Custom(10) AlreadyRecorded (double-spend guard).
 *   3. Record an all-zero nullifier     -> REJECTED Custom(11) InvalidNullifier.
 *
 * Usage:
 *   node scripts/zk/nullifier-record-e2e.mjs --program <ID> --cluster devnet|mainnet-beta
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i !== -1 ? process.argv[i + 1] : d; };
const PROGRAM_ID = arg("program");
const CLUSTER = arg("cluster", "devnet");
const RPC = arg("rpc", CLUSTER === "mainnet-beta" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
const SEED = Buffer.from("null_record");

const isCustom = (e, n) => !!(e && e.InstructionError && e.InstructionError[1] && e.InstructionError[1].Custom === n);

async function main() {
  if (!PROGRAM_ID) throw new Error("--program <ID> required");
  const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram } = await import("@solana/web3.js");
  const keyPath = execSync("solana config get", { encoding: "utf8" }).match(/Keypair Path:\s+(.+)/)?.[1]?.trim();
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));
  const conn = new Connection(RPC, "confirmed");
  const pid = new PublicKey(PROGRAM_ID);

  const pdaFor = (nullifier) => PublicKey.findProgramAddressSync([SEED, nullifier], pid)[0];
  const mkIx = (nullifier, pda) => new TransactionInstruction({
    programId: pid,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([0x00]), nullifier]),
  });
  const send = async (nullifier) => {
    const pda = pdaFor(nullifier);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: payer.publicKey }).add(mkIx(nullifier, pda));
    tx.sign(payer);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    return sig;
  };
  const simErr = async (nullifier) => {
    const pda = pdaFor(nullifier);
    const tx = new Transaction({ feePayer: payer.publicKey }).add(mkIx(nullifier, pda));
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(payer);
    return (await conn.simulateTransaction(tx)).value.err;
  };

  console.log(`dark_nullifier_record e2e — ${CLUSTER}  program ${PROGRAM_ID}`);
  const nullifier = createHash("sha256").update(randomBytes(32)).digest(); // fresh each run
  console.log(`  nullifier ${nullifier.toString("hex").slice(0, 16)}…  pda ${pdaFor(nullifier).toBase58()}`);

  // 1. positive — record a fresh nullifier
  const sig1 = await send(nullifier);
  console.log(`  RECORD positive: CONFIRMED  ${sig1}`);

  // 2. double-spend — same nullifier must be rejected
  const dbl = isCustom(await simErr(nullifier), 10);
  console.log(`  DOUBLE-SPEND (same nullifier): ${dbl ? "REJECTED Custom(10) AlreadyRecorded" : "!! NOT REJECTED"}`);

  // 3. zero nullifier must be rejected
  const zok = isCustom(await simErr(Buffer.alloc(32)), 11);
  console.log(`  ZERO nullifier: ${zok ? "REJECTED Custom(11) InvalidNullifier" : "!! NOT REJECTED"}`);

  const pass = dbl && zok;
  mkdirSync(join(REPO, "evidence", "zk"), { recursive: true });
  const ev = {
    test: "dark_nullifier_record-onchain-e2e",
    cluster: CLUSTER, program: PROGRAM_ID,
    pdaSeed: "[\"null_record\", nullifier(32)]",
    tests: {
      recordPositive: { result: "CONFIRMED", tx: sig1 },
      doubleSpendSame: dbl ? "REJECTED Custom(10)" : "FAIL",
      zeroNullifier: zok ? "REJECTED Custom(11)" : "FAIL",
    },
    explorer: `https://explorer.solana.com/tx/${sig1}?cluster=${CLUSTER}`,
  };
  writeFileSync(join(REPO, "evidence", "zk", `nullifier-record-${CLUSTER}.json`), JSON.stringify(ev, null, 2) + "\n");
  console.log(`\nRESULT (${CLUSTER}): ${pass ? "anti-replay PROVEN — record OK; double-spend + zero REJECTED" : "FAIL"}`);
  if (!pass) process.exit(1);
}
main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
