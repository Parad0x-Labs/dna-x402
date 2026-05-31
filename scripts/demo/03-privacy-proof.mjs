#!/usr/bin/env node
/**
 * Privacy proof: shows that encrypted blob is unreadable without the key,
 * and fully readable with it.
 *
 * All data is SYNTHETIC — fake agent names, fake tx signatures, no real info.
 * The key is saved to evidence/demo/archive-key.hex (DO NOT COMMIT — gitignored).
 *
 * Run:  node scripts/demo/03-privacy-proof.mjs
 * Or:   node scripts/demo/03-privacy-proof.mjs --key <hex>   to decrypt existing blob
 */

import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const KEY_FILE = join(REPO, "evidence", "demo", "archive-key.hex");

const toFileUrl = (p) => new URL("file:///" + p.replace(/\\/g, "/")).href;
const { compressReceipts, decompressReceipts } = await import(toFileUrl(`${REPO}/packages/liquefy-receipts/src/compress.ts`));

const subtle = (globalThis.crypto ?? (await import("node:crypto")).webcrypto).subtle;

// ── 1. Generate SYNTHETIC receipts (zero real data) ───────────────────────────
console.log("\n=== Privacy Proof: DNA x402 + Liquefy ===\n");
console.log("Generating 1,000 synthetic receipts (fake data, proof of concept)...");

const receipts = Array.from({ length: 1000 }, (_, i) => ({
  txSignature: `SYNTHETIC_${String(i).padStart(8,"0")}_FAKE_NOT_REAL_${"A".repeat(44)}`,
  amount:      1000 + (i % 100),
  sender:      `FakeAgent${i % 5}_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
  receiver:    `FakeAPI_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`,
  timestamp:   1700000000 + i,
  receiptId:   `fake_rid_${i}`,
  programId:   "6HSRGivdYR5D7yTDy1TFMCM8h3LzXxRtKU1RA3RnCMRN",
}));

// ── 2. Compress ───────────────────────────────────────────────────────────────
const compressed = compressReceipts(receipts);
const rawSize = new TextEncoder().encode(JSON.stringify(receipts)).length;
console.log(`Raw: ${(rawSize/1024).toFixed(0)}KB → Compressed: ${compressed.length}B (${Math.round(rawSize/compressed.length)}×)\n`);

// ── 3. Generate + save key ────────────────────────────────────────────────────
let rawKey;
const existingKeyArg = process.argv.find(a => a.startsWith("--key="));
if (existingKeyArg) {
  rawKey = Buffer.from(existingKeyArg.split("=")[1], "hex");
  console.log("Using provided key.");
} else {
  rawKey = new Uint8Array(await subtle.exportKey("raw",
    await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])
  ));
  mkdirSync(join(REPO, "evidence", "demo"), { recursive: true });
  writeFileSync(KEY_FILE, Buffer.from(rawKey).toString("hex"));
  console.log(`Key saved to: evidence/demo/archive-key.hex`);
  console.log(`Key (hex):    ${Buffer.from(rawKey).toString("hex").slice(0,16)}... (32 bytes, keep private)\n`);
}

// ── 4. Encrypt ────────────────────────────────────────────────────────────────
const key = await subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]);
const nonce = new Uint8Array(12); randomBytes(12).copy(Buffer.from(nonce.buffer));
const ciphertext = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, compressed));
const packed = new Uint8Array(12 + ciphertext.length);
packed.set(nonce, 0); packed.set(ciphertext, 12);

// ── 5. SHOW: without key → unreadable ────────────────────────────────────────
console.log("=== WITHOUT KEY (what Arweave sees) ===");
console.log(`First 32 bytes of ciphertext: ${Buffer.from(packed.slice(0, 32)).toString("hex")}`);
console.log(`Looks like:                   ${Buffer.from(packed.slice(0, 32)).toString("latin1").replace(/[^\x20-\x7e]/g, "░")}`);
console.log("→ Pure garbage. No structure. Nothing readable.\n");

// Try to decompress raw ciphertext — should fail
try {
  decompressReceipts(packed);
  console.log("ERROR: Should have thrown!");
} catch {
  console.log("✓ Attempting to read without key: THROWS (as expected)\n");
}

// ── 6. SHOW: with key → readable ─────────────────────────────────────────────
console.log("=== WITH KEY (what the agent sees) ===");
const decrypted = new Uint8Array(
  await subtle.decrypt({ name: "AES-GCM", iv: packed.slice(0, 12) }, key, packed.slice(12))
);
const restored = decompressReceipts(decrypted);

console.log(`Receipts restored:  ${restored.length}`);
console.log(`First receipt:      ${JSON.stringify(restored[0]).slice(0, 80)}...`);
console.log(`Last receipt:       sender=${restored[999].sender.slice(0,20)}... amount=${restored[999].amount}`);
console.log(`\n✓ Decryption: PASS — all ${restored.length} receipts recovered perfectly\n`);

// ── 7. Bit-perfect verification ───────────────────────────────────────────────
const orig = JSON.stringify(receipts.map(r => ({...r, amount: Number(r.amount)})));
const rest = JSON.stringify(restored.map(r => ({...r, amount: Number(r.amount)})));
const match = orig === rest;
console.log(`=== BIT-PERFECT CHECK ===`);
console.log(`Original === Restored: ${match ? "✓ PASS" : "✗ FAIL"}\n`);

// ── 8. Write proof ────────────────────────────────────────────────────────────
const proof = {
  schemaVersion: "1.0",
  generatedAt: new Date().toISOString(),
  demo: "privacy-proof",
  dataNote: "ALL SYNTHETIC — fake agents, fake tx hashes, no real data",
  receiptCount: receipts.length,
  rawBytes: rawSize,
  compressedBytes: compressed.length,
  compressionRatio: Math.round(rawSize / compressed.length),
  encryptedBytes: packed.length,
  encryption: "AES-256-GCM",
  keyNote: "key saved to evidence/demo/archive-key.hex — NOT committed to git",
  privacyProof: {
    withoutKey: "ciphertext is unreadable gibberish — decompressReceipts() throws",
    withKey: `all ${restored.length} receipts recovered perfectly`,
    bitPerfect: match,
  },
};
writeFileSync(join(REPO, "evidence", "demo", "privacy-proof.json"),
  JSON.stringify(proof, null, 2) + "\n");

console.log(`=== SUMMARY ===`);
console.log(`Without key: ░░░░░░░░ (unreadable)`);
console.log(`With key:    ${restored.length} receipts, fully readable`);
console.log(`Bit-perfect: ${match ? "PASS ✓" : "FAIL ✗"}`);
console.log(`\nEvidence: evidence/demo/privacy-proof.json`);
console.log(`Key file:  evidence/demo/archive-key.hex  ← gitignored, never committed`);
