/**
 * Post-deploy init for null_registrar on MAINNET.
 * Same logic as devnet version — IS_MAINNET_READY=false so NULL fee is skipped.
 *
 * Usage: node scripts/post-mainnet/init-null-registrar-mainnet.mjs <PROGRAM_ID>
 */

import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const CLUSTER      = "https://api.mainnet-beta.solana.com";
const CONFIG_PATH  = "configs/mainnet.commercial.json";
const PROGRAM_ID   = new PublicKey(process.argv[2] ?? "GRasGMtZsvvymw5BqY1ZpG1Hy15XEK7nz4Z6fTA6cMP8");
const NULL_MINT    = new PublicKey("8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump");

const REGISTRY_SEED = Buffer.from("null-registry");
const DOMAIN_SEED   = Buffer.from("null-domain");
const IX_INIT = 0x01;
const IX_REG  = 0x02;

const PLACEHOLDER_HASH = createHash("sha256")
  .update("parad0x.null:web0:mainnet:2026")
  .digest();

function loadKeypair() {
  const path = `${homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

const payer = loadKeypair();
const connection = new Connection(CLUSTER, "confirmed");

const [configPDA] = PublicKey.findProgramAddressSync([REGISTRY_SEED], PROGRAM_ID);
const nameBytes   = Buffer.from("parad0x", "utf8");
const [domainPDA] = PublicKey.findProgramAddressSync([DOMAIN_SEED, nameBytes], PROGRAM_ID);

console.log("Deployer  :", payer.publicKey.toBase58());
console.log("Program   :", PROGRAM_ID.toBase58());
console.log("ConfigPDA :", configPDA.toBase58());
console.log("DomainPDA :", domainPDA.toBase58());

// Step 1 — InitRegistry (skip if already done)
const configInfo = await connection.getAccountInfo(configPDA);
if (configInfo?.data.length > 0) {
  console.log("\nStep 1: Registry already initialised — skipping");
} else {
  console.log("\nStep 1: InitRegistry...");
  const data = Buffer.alloc(1 + 8 + 32 + 32);
  data.writeUInt8(IX_INIT, 0);
  data.writeBigUInt64LE(0n, 1);
  Buffer.from(NULL_MINT.toBytes()).copy(data, 9);
  Buffer.from(payer.publicKey.toBytes()).copy(data, 41);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: payer.publicKey,         isSigner: true,  isWritable: true  },
      { pubkey: configPDA,               isSigner: false, isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer], { commitment: "confirmed" });
  console.log("  ✅ sig:", sig);
}

// Step 2 — Register parad0x
console.log("\nStep 2: Register parad0x.null on mainnet...");
const regData = Buffer.alloc(1 + 64 + 32);
regData.writeUInt8(IX_REG, 0);
nameBytes.copy(regData, 1);
PLACEHOLDER_HASH.copy(regData, 65);

const regIx = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: payer.publicKey,         isSigner: true,  isWritable: true  },
    { pubkey: domainPDA,               isSigner: false, isWritable: true  },
    { pubkey: configPDA,               isSigner: false, isWritable: true  },
    { pubkey: payer.publicKey,         isSigner: false, isWritable: false },
    { pubkey: payer.publicKey,         isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: regData,
});
const regSig = await sendAndConfirmTransaction(connection, new Transaction().add(regIx), [payer], { commitment: "confirmed" });
console.log("  ✅ sig:", regSig);
console.log("  🟣 parad0x.null is live on MAINNET!");

// Update configs/mainnet.commercial.json
const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
cfg.programs.nullRegistrar = PROGRAM_ID.toBase58();
writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
console.log("\n  configs/mainnet.commercial.json updated");

console.log("\n── Summary ─────────────────────────────────────────────────────");
console.log("Program   :", PROGRAM_ID.toBase58());
console.log("ConfigPDA :", configPDA.toBase58());
console.log("DomainPDA :", domainPDA.toBase58());
console.log("Explorer  : https://explorer.solana.com/address/" + PROGRAM_ID.toBase58());
