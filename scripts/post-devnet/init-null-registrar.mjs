/**
 * Post-deploy init for null_registrar on devnet.
 *
 * Steps:
 *   1. InitRegistry  — creates the RegistryConfig PDA (one-time)
 *   2. Register "parad0x" — mints parad0x.null with a placeholder content hash
 *
 * Run after deploying the program:
 *   node scripts/post-devnet/init-null-registrar.mjs <PROGRAM_ID>
 *
 * The program ID is written to configs/devnet.oss.json automatically.
 * Update the content hash later (once the site is on Arweave) via UpdateContent.
 *
 * Accounts (InitRegistry):   payer, configPDA, systemProgram
 * Accounts (Register):       payer, domainPDA, configPDA, nullSrc*, treasury*, systemProgram
 * (* = IS_MAINNET_READY=false so these are pass-through dummies — payer is used)
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

// ── Config ──────────────────────────────────────────────────────────────────

const CLUSTER    = "https://api.devnet.solana.com";
const CONFIG_PATH = "configs/devnet.oss.json";

const PROGRAM_ID_ARG = process.argv[2];
if (!PROGRAM_ID_ARG) {
  console.error("Usage: node scripts/post-devnet/init-null-registrar.mjs <PROGRAM_ID>");
  process.exit(1);
}
const PROGRAM_ID = new PublicKey(PROGRAM_ID_ARG);

// NULL token mint (same on devnet — the mint exists cross-network)
const NULL_MINT = new PublicKey("8EeDdvCRmFAzVD4takkBrNNwkeUTUQh4MscRK5Fzpump");

// Placeholder content hash for parad0x.null — SHA-256 of a human-readable
// marker so it's recognisable in explorers. Owner can call UpdateContent once
// the real Arweave page is uploaded.
const PLACEHOLDER_CONTENT_HASH = createHash("sha256")
  .update("parad0x.null:web0:coming-soon:2026")
  .digest(); // 32-byte Buffer

// PDA seeds (must match processor.rs constants)
const REGISTRY_SEED = Buffer.from("null-registry");
const DOMAIN_SEED   = Buffer.from("null-domain");

// Instruction discriminants (must match instruction.rs)
const IX_INIT_REGISTRY = 0x01;
const IX_REGISTER      = 0x02;

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadKeypair(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function deriveRegistryConfig(programId) {
  return PublicKey.findProgramAddressSync([REGISTRY_SEED], programId);
}

function deriveDomainPDA(name, programId) {
  // Seed = printable bytes only (NOT the 64-byte padded buffer).
  // Solana enforces a 32-byte per-seed limit; the 64-byte buffer would exceed
  // it on both client and on-chain. Printable bytes (1-32 chars) are unique
  // per name so PDA uniqueness is preserved. Must match processor.rs fix.
  const nameBytes = Buffer.from(name, "utf8");
  if (nameBytes.length > 32) throw new Error(`Name "${name}" exceeds 32 bytes`);
  return PublicKey.findProgramAddressSync([DOMAIN_SEED, nameBytes], programId);
}

// ── Build InitRegistry instruction data ─────────────────────────────────────
// Layout: [u8 disc] + [u64 fee LE] + [32 null_mint] + [32 treasury]
function buildInitRegistryData(fee, nullMintBytes, treasuryBytes) {
  const buf = Buffer.alloc(1 + 8 + 32 + 32);
  buf.writeUInt8(IX_INIT_REGISTRY, 0);
  buf.writeBigUInt64LE(BigInt(fee), 1);
  Buffer.from(nullMintBytes).copy(buf, 9);
  Buffer.from(treasuryBytes).copy(buf, 41);
  return buf;
}

// ── Build Register instruction data ─────────────────────────────────────────
// Layout: [u8 disc] + [64 name null-padded] + [32 content_hash]
function buildRegisterData(name, contentHashBytes) {
  const buf = Buffer.alloc(1 + 64 + 32);
  buf.writeUInt8(IX_REGISTER, 0);
  const nameBytes = Buffer.from(name, "utf8");
  nameBytes.copy(buf, 1); // rest of the 64 bytes stay 0x00
  Buffer.from(contentHashBytes).copy(buf, 65);
  return buf;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const connection = new Connection(CLUSTER, "confirmed");

// Load deployer — same as used for all other devnet deployments
const keypairPath = `${homedir()}/.config/solana/id.json`;
const payer = loadKeypair(keypairPath);
console.log("Deployer :", payer.publicKey.toBase58());

const [configPDA, configBump] = deriveRegistryConfig(PROGRAM_ID);
console.log("ConfigPDA:", configPDA.toBase58(), " bump:", configBump);

const nameToDomain = "parad0x";
// PDA seed uses printable bytes only; instruction payload uses 64-byte padded buffer.
const [domainPDA, domainBump] = deriveDomainPDA(nameToDomain, PROGRAM_ID);
console.log("DomainPDA:", domainPDA.toBase58(), " bump:", domainBump);
console.log("Program  :", PROGRAM_ID.toBase58());
console.log();

// ── Step 1: InitRegistry ────────────────────────────────────────────────────

console.log("Step 1: InitRegistry...");

const initData = buildInitRegistryData(
  0,                          // fee = 0 (IS_MAINNET_READY=false skips the debit anyway)
  NULL_MINT.toBytes(),        // null_mint
  payer.publicKey.toBytes(),  // treasury = deployer for devnet
);

const initIx = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: payer.publicKey, isSigner: true,  isWritable: true  }, // payer
    { pubkey: configPDA,       isSigner: false, isWritable: true  }, // config PDA
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system
  ],
  data: initData,
});

const initTx = new Transaction().add(initIx);
// Check if already initialised (idempotency — registry was created on first run)
const configInfo = await connection.getAccountInfo(configPDA);
if (configInfo && configInfo.data.length > 0) {
  console.log("  ℹ️  Registry already initialised — skipping InitRegistry");
} else {
  const initSig = await sendAndConfirmTransaction(connection, initTx, [payer], {
    commitment: "confirmed",
  });
  console.log("  ✅ InitRegistry sig:", initSig);
}
console.log("  Config PDA:", configPDA.toBase58());

// ── Step 2: Register "parad0x" ───────────────────────────────────────────────

console.log("\nStep 2: Register parad0x.null...");
console.log("  Content hash placeholder:", PLACEHOLDER_CONTENT_HASH.toString("hex"));
console.log("  (Update via UpdateContent once site is on Arweave)");

const regData = buildRegisterData(nameToDomain, PLACEHOLDER_CONTENT_HASH);

const regIx = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: payer.publicKey, isSigner: true,  isWritable: true  }, // payer / owner
    { pubkey: domainPDA,       isSigner: false, isWritable: true  }, // domain PDA
    { pubkey: configPDA,       isSigner: false, isWritable: true  }, // config PDA
    { pubkey: payer.publicKey, isSigner: false, isWritable: false }, // null_src (dummy, IS_MAINNET_READY=false)
    { pubkey: payer.publicKey, isSigner: false, isWritable: false }, // treasury (dummy)
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system
  ],
  data: regData,
});

const regTx = new Transaction().add(regIx);
const regSig = await sendAndConfirmTransaction(connection, regTx, [payer], {
  commitment: "confirmed",
});
console.log("  ✅ Register sig:", regSig);
console.log("  Domain PDA:", domainPDA.toBase58());
console.log("\n🟣 parad0x.null is live on devnet!");
console.log("   Resolves to placeholder hash:", PLACEHOLDER_CONTENT_HASH.toString("hex"));
console.log("   Update with real Arweave TX via UpdateContent once site is uploaded.");

// ── Write program ID to configs/devnet.oss.json ──────────────────────────────

console.log("\nUpdating", CONFIG_PATH, "...");
const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
cfg.programs.nullRegistrar = PROGRAM_ID.toBase58();
writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
console.log("  ✅ configs/devnet.oss.json updated");

// ── Summary ──────────────────────────────────────────────────────────────────

console.log("\n── Summary ─────────────────────────────────────────────────────");
console.log("Program ID :", PROGRAM_ID.toBase58());
console.log("Config PDA :", configPDA.toBase58());
console.log("parad0x PDA:", domainPDA.toBase58());
console.log("Content    :", PLACEHOLDER_CONTENT_HASH.toString("hex"), "(placeholder)");
console.log("Explorer   : https://explorer.solana.com/address/" + PROGRAM_ID.toBase58() + "?cluster=devnet");
console.log();
console.log("Next steps:");
console.log("  1. Set this program ID in extensions/null-resolver/background.js DEFAULT_PROGRAM_ID");
console.log("  2. Change DEFAULT_RPC to https://api.devnet.solana.com in background.js");
console.log("  3. Upload site content to Arweave, then call UpdateContent with the real TX hash");
console.log("  4. Submit extension to Chrome Web Store");
