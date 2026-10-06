#!/usr/bin/env node
/**
 * DARK RELAY RAIL — denomination buckets (amount privacy) DEVNET init.
 *
 * Stands up N fixed-denomination shielded pools (0.1 / 1 / 10 SOL by default). Fixed
 * denominations are how the rail hides AMOUNTS: every note in a bucket is identical, so
 * a withdrawal reveals only "one 0.1-SOL note", never the user's actual balance or the
 * exact amount they are moving. Arbitrary amounts are moved by SPLITTING across buckets
 * (see the printed splitting guide / docs/DARK_RELAY_RAIL.md).
 *
 * Each bucket is its own pool, created with InitBucketPool (0x05): the pool seed key is
 * the program PDA ["bucket_authority", admin, denom_le] (no private key exists for it)
 * and the Pause/Resume authority stored in the config is the admin wallet (the signer of
 * this script). Re-running is idempotent (same admin + denom => same pool PDA).
 *
 * Earlier revisions used Keypair.fromSeed(sha256(tag || denom || wallet pubkey)) as the
 * authority; anyone can recompute that key from public data and Pause/Resume the bucket.
 *
 * Usage: node build/zk/init-buckets-devnet.mjs <PROGRAM_ID> [--denoms 100000000,1000000000,10000000000]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram,
} from "@solana/web3.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const RPC = process.env.RPC ?? "https://api.devnet.solana.com";
const CLUSTER = RPC.includes("mainnet") ? "mainnet-beta" : "devnet";
const PROGRAM_ID = new PublicKey(process.argv[2]);
const denomsArg = (() => { const i = process.argv.indexOf("--denoms"); return i !== -1 ? process.argv[i + 1] : null; })();
const DENOMS = (denomsArg ? denomsArg.split(",") : ["100000000", "1000000000", "10000000000"]).map((s) => BigInt(s));

const conn = new Connection(RPC, "confirmed");
const keyPath = execFileSync("solana", ["config", "get"], { encoding: "utf8" }).match(/Keypair Path:\s+(.+)/)[1].trim();
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8"))));

const SEEDS = { config: Buffer.from("pool_config"), vault: Buffer.from("pool_vault") };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const SYS = SystemProgram.programId;

// Program-derived bucket key: PDA(["bucket_authority", admin, denom_le]). Not a keypair.
function bucketAuthority(denom) {
  return PublicKey.findProgramAddressSync([Buffer.from("bucket_authority"), wallet.publicKey.toBuffer(), u64le(denom)], PROGRAM_ID)[0];
}

async function send(ixs, signers, feePayer, label) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer });
  for (const ix of ixs) tx.add(ix);
  tx.sign(...signers);
  let sig;
  try {
    sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  } catch (e) { return { ok: false, sig: null, err: e.message }; }
  let meta = null;
  for (let a = 0; a < 8 && !meta; a++) {
    const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (t?.meta) meta = t.meta; else await new Promise((r) => setTimeout(r, 800));
  }
  return { ok: (meta?.err ?? null) === null, sig, err: meta?.err ?? null, logs: meta?.logMessages ?? [] };
}

async function main() {
  console.log(`\n=== DARK RELAY RAIL — denomination buckets init (${CLUSTER}) ===`);
  console.log(`program ${PROGRAM_ID.toBase58()}`);
  const buckets = [];

  for (const denom of DENOMS) {
    const bucket = bucketAuthority(denom);
    const [poolConfig] = PublicKey.findProgramAddressSync([SEEDS.config, bucket.toBuffer()], PROGRAM_ID);
    const [poolVault] = PublicKey.findProgramAddressSync([SEEDS.vault, poolConfig.toBuffer()], PROGRAM_ID);
    const sol = Number(denom) / 1e9;
    console.log(`\n[bucket ${sol} SOL] bucket PDA ${bucket.toBase58()}  admin ${wallet.publicKey.toBase58()}`);
    console.log(`  config ${poolConfig.toBase58()}  vault ${poolVault.toBase58()}`);

    // Already initialized?
    const existing = await conn.getAccountInfo(poolConfig, "confirmed");
    if (existing && existing.data.length > 0) {
      const onChainDenom = Buffer.from(existing.data.slice(36, 44)).readBigUInt64LE();
      console.log(`  already initialized (denom=${onChainDenom}); skipping`);
      buckets.push({ denomLamports: denom.toString(), denomSol: sol, bucketAuthority: bucket.toBase58(), admin: wallet.publicKey.toBase58(), poolConfig: poolConfig.toBase58(), poolVault: poolVault.toBase58(), initSig: null, status: "already-initialized" });
      continue;
    }

    // InitBucketPool: the admin wallet pays config+vault rent (~0.013 SOL) and signs.
    const initIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: poolConfig, isSigner: false, isWritable: true },
        { pubkey: poolVault, isSigner: false, isWritable: true },
        { pubkey: bucket, isSigner: false, isWritable: false },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SYS, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([Buffer.from([0x05]), u64le(denom)]),
    });
    const r = await send([initIx], [wallet], wallet.publicKey, "init");
    console.log(`  init: ${r.ok ? "OK " + r.sig : "FAIL " + JSON.stringify(r.err)}`);
    buckets.push({ denomLamports: denom.toString(), denomSol: sol, bucketAuthority: bucket.toBase58(), admin: wallet.publicKey.toBase58(), poolConfig: poolConfig.toBase58(), poolVault: poolVault.toBase58(), initSig: r.sig, status: r.ok ? "initialized" : "failed" });
  }

  // splitting guidance
  const example = 12_300_000_000n; // 12.3 SOL example
  const greedy = [];
  let rem = example;
  for (const d of [...DENOMS].sort((a, b) => (b > a ? 1 : -1))) { const k = rem / d; if (k > 0n) { greedy.push({ denomSol: Number(d) / 1e9, count: Number(k) }); rem -= k * d; } }

  const out = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    test: "dark_relay_rail-denomination-buckets",
    cluster: CLUSTER,
    program: PROGRAM_ID.toBase58(),
    buckets,
    amountPrivacy: "Fixed denominations hide amounts: every note in a bucket is identical, so a withdrawal reveals only the bucket, never the user's balance or exact transfer amount.",
    arbitraryAmountSplitting: {
      method: "Greedy decomposition over the available buckets (largest-first), one shielded note per unit. Each note is deposited + withdrawn independently, so the on-chain footprint is a set of identical bucket operations.",
      example: { amountSol: Number(example) / 1e9, decomposition: greedy, remainderLamports: rem.toString() },
      note: "A non-representable remainder (smaller than the smallest bucket) is either paid transparently or rounded by the wallet; arbitrary-precision privacy requires a smallest-bucket dust denomination.",
    },
  };
  mkdirSync(join(REPO, "evidence"), { recursive: true });
  writeFileSync(join(REPO, "evidence", "dark-relay-rail-buckets-devnet.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`\nEvidence: evidence/dark-relay-rail-buckets-devnet.json`);
  console.log(`Buckets: ${buckets.map((b) => `${b.denomSol}SOL=${b.status}`).join(", ")}`);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
