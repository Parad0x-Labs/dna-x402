/**
 * Upload updated parad0x.null page to Arweave, then call UpdateContent
 * on mainnet so parad0x.null resolves to the real mainnet page.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash }                  from "node:crypto";
import { homedir }                     from "node:os";
import {
  Connection, Keypair, PublicKey, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from "@solana/web3.js";

const CLUSTER    = "https://api.mainnet-beta.solana.com";
// Live registrar from config — no hardcoded program IDs.
const PROGRAM_ID = new PublicKey(
  JSON.parse(readFileSync("configs/mainnet.commercial.json", "utf8")).programs.nullRegistrar
);
const HTML_PATH  = "site/null/parad0x.html";
const DOMAIN_SEED = Buffer.from("null-domain");

function loadKeypair() {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8")))
  );
}

const payer = loadKeypair();
console.log("Wallet:", payer.publicKey.toBase58());

// Upload to Arweave
console.log("\nStep 1: Uploading mainnet page to Arweave...");
const html = readFileSync(HTML_PATH, "utf8");
const { default: Irys } = await import("@irys/sdk");
const irys = new Irys({ network: "mainnet", token: "solana", key: Buffer.from(payer.secretKey) });

const receipt = await irys.upload(Buffer.from(html, "utf8"), {
  tags: [
    { name: "Content-Type",  value: "text/html; charset=utf-8" },
    { name: "App-Name",      value: "parad0x.null" },
    { name: "Web0-Domain",   value: "parad0x.null" },
    { name: "Network",       value: "mainnet" },
    { name: "Null-Program",  value: PROGRAM_ID.toBase58() },
  ],
});
const txId       = receipt.id;
const contentHash = createHash("sha256").update(Buffer.from(txId, "utf8")).digest();
console.log("  ✅ Arweave TX:", txId);
console.log("  🌐 URL: https://arweave.net/" + txId);

// UpdateContent on mainnet
console.log("\nStep 2: UpdateContent on mainnet...");
const nameBytes  = Buffer.from("parad0x", "utf8");
const [domainPDA] = PublicKey.findProgramAddressSync([DOMAIN_SEED, nameBytes], PROGRAM_ID);
const ixData = Buffer.alloc(1 + 64 + 32);
ixData.writeUInt8(0x03, 0);
nameBytes.copy(ixData, 1);
contentHash.copy(ixData, 65);

const ix  = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: payer.publicKey, isSigner: true, isWritable: false },
    { pubkey: domainPDA,       isSigner: false, isWritable: true },
  ],
  data: ixData,
});
const sig = await sendAndConfirmTransaction(
  new Connection(CLUSTER, "confirmed"),
  new Transaction().add(ix),
  [payer],
  { commitment: "confirmed" }
);
console.log("  ✅ UpdateContent sig:", sig);

// Save evidence
writeFileSync("evidence/mainnet/parad0x-null-mainnet.json", JSON.stringify({
  domain: "parad0x.null", network: "mainnet",
  arweaveTxId: txId, arweaveUrl: `https://arweave.net/${txId}`,
  contentHash: contentHash.toString("hex"),
  domainPDA: domainPDA.toBase58(), programId: PROGRAM_ID.toBase58(),
  updateSig: sig, timestamp: new Date().toISOString(),
}, null, 2) + "\n");

console.log("\n🟣 parad0x.null → mainnet → Arweave. Live forever.");
console.log("   https://arweave.net/" + txId);
