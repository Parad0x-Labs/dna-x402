/**
 * Upload parad0x.null site to Arweave via Irys, then call UpdateContent
 * on devnet so parad0x.null resolves to the real page.
 *
 * Usage: node scripts/post-devnet/upload-parad0x-null.mjs
 *
 * Irys free tier covers files under ~100KB so no payment is needed.
 * Uses the Solana CLI keypair (same deployer as the program).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createHash }                             from "node:crypto";
import { homedir }                                from "node:os";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

// ── Config ──────────────────────────────────────────────────────────────────

const CLUSTER      = "https://api.devnet.solana.com";
const PROGRAM_ID   = new PublicKey("3mqpDJ6c84nVDwGPHEbtH5vbaDqRtPidAK5JX5KRzBB4");
const HTML_PATH    = "site/null/parad0x.html";
const EVIDENCE_OUT = "evidence/mainnet/parad0x-null-arweave.json";

const REGISTRY_SEED = Buffer.from("null-registry");
const DOMAIN_SEED   = Buffer.from("null-domain");
const IX_UPDATE     = 0x03;

function loadKeypair() {
  const path = `${homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

// SHA-256 of a UTF-8 string → 32-byte Buffer (arweave content hash)
function sha256(data) {
  return createHash("sha256").update(data).digest();
}

// ── Step 1: Upload to Arweave via Irys ──────────────────────────────────────

console.log("Step 1: Uploading parad0x.null to Arweave via Irys...");

const html     = readFileSync(HTML_PATH, "utf8");
const htmlSize = Buffer.byteLength(html, "utf8");
console.log(`  File: ${HTML_PATH} (${htmlSize} bytes)`);

const payer = loadKeypair();
console.log("  Wallet:", payer.publicKey.toBase58());

// Dynamically import Irys (ESM)
const { default: Irys } = await import("@irys/sdk");
const irys = new Irys({
  network: "mainnet",
  token: "solana",
  key: Buffer.from(payer.secretKey), // raw Buffer — SDK does its own bs58 encoding
});

// Check balance / free tier
const price = await irys.getPrice(htmlSize);
console.log(`  Upload cost: ${irys.utils.fromAtomic(price)} SOL`);

// Irys free tier: files under ~100KB upload at no cost on mainnet
const uploadReceipt = await irys.upload(Buffer.from(html, "utf8"), {
  tags: [
    { name: "Content-Type",     value: "text/html; charset=utf-8" },
    { name: "App-Name",         value: "parad0x.null" },
    { name: "Web0-Domain",      value: "parad0x.null" },
    { name: "Null-Program",     value: PROGRAM_ID.toBase58() },
    { name: "Owner",            value: payer.publicKey.toBase58() },
    { name: "Version",          value: "1.0.0" },
  ],
});

const arweaveTxId  = uploadReceipt.id;
const arweaveUrl   = `https://arweave.net/${arweaveTxId}`;
console.log(`  ✅ Arweave TX: ${arweaveTxId}`);
console.log(`  🌐 URL: ${arweaveUrl}`);

// The content_hash stored in the NullDomain PDA is SHA-256 of the Arweave TX ID
const arweaveTxIdBytes  = Buffer.from(arweaveTxId, "utf8");
const contentHashBuffer = sha256(arweaveTxIdBytes);
console.log(`  Content hash (sha256 of TX ID): ${contentHashBuffer.toString("hex")}`);

// ── Step 2: UpdateContent on devnet ─────────────────────────────────────────

console.log("\nStep 2: Calling UpdateContent on devnet...");

const connection = new Connection(CLUSTER, "confirmed");

// Derive domain PDA (printable bytes only — matches fixed processor.rs)
const nameBytes = Buffer.from("parad0x", "utf8");
const [domainPDA] = PublicKey.findProgramAddressSync(
  [DOMAIN_SEED, nameBytes],
  PROGRAM_ID,
);
console.log("  Domain PDA:", domainPDA.toBase58());

// Build UpdateContent instruction data: [0x03] + [64 name null-padded] + [32 new_content_hash]
const ixData = Buffer.alloc(1 + 64 + 32);
ixData.writeUInt8(IX_UPDATE, 0);
nameBytes.copy(ixData, 1);                       // name at offset 1, rest zero-padded
contentHashBuffer.copy(ixData, 65);              // new_content_hash at offset 65

const updateIx = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: false }, // owner
    { pubkey: domainPDA,       isSigner: false, isWritable: true  }, // domain PDA
  ],
  data: ixData,
});

const tx  = new Transaction().add(updateIx);
const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
console.log("  ✅ UpdateContent sig:", sig);
console.log("  parad0x.null now resolves to Arweave!");

// ── Step 3: Write evidence ────────────────────────────────────────────────────

const evidence = {
  domain:         "parad0x.null",
  arweaveTxId,
  arweaveUrl,
  contentHash:    contentHashBuffer.toString("hex"),
  domainPDA:      domainPDA.toBase58(),
  programId:      PROGRAM_ID.toBase58(),
  owner:          payer.publicKey.toBase58(),
  updateContentSig: sig,
  timestamp:      new Date().toISOString(),
};
writeFileSync(EVIDENCE_OUT, JSON.stringify(evidence, null, 2) + "\n");
console.log("\nEvidence written to", EVIDENCE_OUT);

console.log("\n── Summary ─────────────────────────────────────────────────────");
console.log("Domain    : parad0x.null");
console.log("Arweave   :", arweaveUrl);
console.log("TX ID     :", arweaveTxId);
console.log("Hash      :", contentHashBuffer.toString("hex"));
console.log("Explorer  : https://explorer.solana.com/address/" + domainPDA.toBase58() + "?cluster=devnet");
console.log("\n🟣 parad0x.null → Arweave → permanent HTML page. Live.");
